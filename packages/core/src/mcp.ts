import type { McpServer } from "@vibe/config";
import {
  capText,
  createLogger,
  type JsonSchema,
  type Logger,
  omittedMarker,
  type ToolDefinition,
} from "@vibe/shared";
import { createMcpOAuthProvider } from "./mcp-oauth.ts";

/** One MCP tool as reported by the server (incl. the read-only annotation). */
export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  /** Behavioral hints from the server; `readOnlyHint` lets a safe tool skip the
   * permission gate and participate in plan mode. */
  annotations?: { readOnlyHint?: boolean };
}

/** An MCP resource a server exposes (read via `read_mcp_resource`). */
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** An MCP prompt a server exposes (reachable via the `get_mcp_prompt` tool). */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** Per-tool-call deadline: parity with the built-ins' bounded execution — a
 * hung MCP server call must not wedge the turn (Esc also now cancels it). */
export const MCP_CALL_TIMEOUT_MS = 120_000;

/** Output cap for MCP tool/resource/prompt results. An MCP result lands in the
 * prompt verbatim like any built-in's, so — same invariant as `read` (100k) —
 * an untrusted server can't dump a multi-MB blob that blows context accounting
 * and 400s the next turn. head+tail keeps a trailing error/summary line. */
export const MCP_MAX_OUTPUT = 100_000;

/** Cap a rendered MCP result the same way built-ins cap their output. */
function capMcpOutput(text: string): string {
  return capText(text, { cap: MCP_MAX_OUTPUT, keep: "head+tail", marker: omittedMarker });
}

/** A connected MCP server, reduced to what the hub needs. */
export interface McpClient {
  listTools(): Promise<McpToolSpec[]>;
  callTool(
    name: string,
    args: unknown,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ content: unknown; isError?: boolean }>;
  /** List the server's resources (optional capability). */
  listResources?(): Promise<McpResource[]>;
  /** Read a resource's contents by uri (optional capability). Threads the turn's
   * abort signal + a per-call deadline so a hung read is cancellable (like callTool). */
  readResource?(
    uri: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ content: unknown }>;
  /** List the server's prompts (optional capability). */
  listPrompts?(): Promise<McpPrompt[]>;
  /** Render a prompt to text by name + args (optional capability). Threads abort
   * + deadline like readResource/callTool so a wedged server can't hold the turn. */
  getPrompt?(
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ content: unknown }>;
  /** Live transport health — false once the connection drops (so `/mcp` and
   * `/doctor` stop reporting a crashed server as healthy). Optional; absent =
   * assumed connected. */
  isConnected?(): boolean;
  /** Subscribe to the server's `notifications/tools/list_changed` (optional). The
   * hub re-lists + re-registers this server's tools when it fires. */
  onListChanged?(cb: () => void): void;
  /** Subscribe to `notifications/resources/list_changed` (optional). The hub
   * re-lists this server's resources so the aggregate tool stays current without
   * waiting for a reconnect. */
  onResourcesChanged?(cb: () => void): void;
  /** Subscribe to `notifications/prompts/list_changed` (optional). The hub
   * re-lists this server's prompts (same rationale as resources). */
  onPromptsChanged?(cb: () => void): void;
  /** Subscribe to transport close (optional). The hub reconnects with backoff. */
  onClose?(cb: () => void): void;
  close(): Promise<void>;
}

/** Connects to an MCP server (injectable so the hub is testable offline). */
export type McpConnect = (name: string, config: McpServer) => Promise<McpClient>;

/** Default per-server connect+list-tools deadline so one hung server can't block boot. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** Reconnect backoff defaults (a dropped server re-dials with exponential backoff). */
const RECONNECT_DEFAULTS = { baseDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 6 };

export interface McpHubDeps {
  registerTool: (def: ToolDefinition) => void;
  /** Remove a tool (MCP re-list / drop). Optional; absent = tools linger on change. */
  unregisterTool?: (name: string) => void;
  connect?: McpConnect;
  logger?: Logger;
  /** Per-server connect timeout (ms). Default 15000. */
  connectTimeoutMs?: number;
  /** Reconnect backoff tuning (mostly for tests). */
  reconnect?: { baseDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
}

/** Reject if `p` doesn't settle within `ms` (so a hung connect is bounded). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms ${what}`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Connects configured MCP servers and registers each server tool as a
 * `mcp__<server>__<tool>` ToolDefinition, so they flow through the normal
 * mode/permission gate (treated as side-effecting). Connection or per-tool
 * failures are logged and skipped — never fatal.
 */
/** Connection outcome for one configured MCP server (for `/mcp`). */
export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  error?: string;
}

/** One configured server's resolved state (client present iff it connected). */
interface McpEntry {
  name: string;
  config: McpServer;
  client?: McpClient;
  toolCount: number;
  /** Exposed tool names currently registered for this server (for re-list/drop). */
  toolNames: string[];
  resources: McpResource[];
  prompts: McpPrompt[];
  error?: string;
}

export class McpHub {
  #deps: McpHubDeps;
  #connect: McpConnect;
  #log: Logger;
  #connectTimeoutMs: number;
  #reconnect: Required<NonNullable<McpHubDeps["reconnect"]>>;
  #entries: McpEntry[] = [];
  #closed = false;
  /** Servers with a reconnect loop in flight (so a drop storm can't stack loops). */
  #reconnecting = new Set<string>();
  /** Whether the aggregate read_mcp_resource / get_mcp_prompt tools are registered
   * (once each, lazily), so a server that first exposes resources/prompts on a
   * later RECONNECT still gets them surfaced to the model. */
  #resourceToolRegistered = false;
  #promptToolRegistered = false;
  /** Every exposed tool name currently live ACROSS all servers. Two servers whose
   * keys sanitize to the same string (e.g. `gh.prod` and `gh_prod`) can produce
   * identical `mcp__<server>__<tool>` names; a per-server `used` set never sees
   * the cross-server clash and the registry silently overwrites the first. This
   * hub-wide set catches it so the later one gets a stable hash suffix. */
  #usedNames = new Set<string>();

  constructor(deps: McpHubDeps) {
    this.#deps = deps;
    this.#connect = deps.connect ?? defaultConnect;
    this.#log = deps.logger ?? createLogger("mcp");
    this.#connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#reconnect = { ...RECONNECT_DEFAULTS, ...deps.reconnect };
  }

  /**
   * Connect every server and register its tools. Servers connect in PARALLEL,
   * each under a wall-clock deadline, so one slow/hung stdio server can't block
   * CLI startup for N×timeout. Safe to call once at boot. Registration + status
   * preserve config order regardless of which connects finish first.
   */
  async start(servers: Record<string, McpServer>): Promise<void> {
    // `enabled: false` keeps a server configured but unconnected.
    const entries = Object.entries(servers).filter(([, c]) => c.enabled !== false);
    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.#connectAndList(name, config)),
    );
    // close() may have run during the connect await (boot/quit overlap): it set
    // #closed and cleared #entries, so repopulating them now would leak the
    // freshly-connected transports past teardown. Close them and bail — mirrors
    // the #closed guard in #scheduleReconnect.
    if (this.#closed) {
      for (const r of results) {
        if (r.status === "fulfilled") await r.value.client.close().catch(() => {});
      }
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const [name, config] = entries[i]!;
      const r = results[i]!;
      if (r.status === "fulfilled") {
        const { client, tools, resources, prompts } = r.value;
        const entry: McpEntry = {
          name,
          config,
          client,
          toolCount: 0,
          toolNames: [],
          resources,
          prompts,
        };
        this.#entries.push(entry);
        this.#registerServerTools(entry, tools, client);
        this.#wire(entry, client);
        this.#log.info(
          `connected MCP server "${name}" (${tools.length} tools` +
            `${resources.length ? `, ${resources.length} resources` : ""}` +
            `${prompts.length ? `, ${prompts.length} prompts` : ""})`,
        );
      } else {
        const message = (r.reason as Error).message;
        this.#entries.push({
          name,
          config,
          toolCount: 0,
          toolNames: [],
          resources: [],
          prompts: [],
          error: message,
        });
        this.#log.error(`MCP server "${name}" failed: ${message}`);
      }
    }
    this.#ensureAggregateTools();
  }

  /** Register the aggregate read_mcp_resource / get_mcp_prompt tools once each,
   * the moment ANY connected server exposes resources/prompts — at boot or on a
   * later reconnect (a server that first advertises them then would otherwise
   * leave the model unable to read them). */
  #ensureAggregateTools(): void {
    if (!this.#resourceToolRegistered && this.#entries.some((e) => e.resources.length)) {
      this.#deps.registerTool(this.#readResourceTool());
      this.#resourceToolRegistered = true;
    }
    if (!this.#promptToolRegistered && this.#entries.some((e) => e.prompts.length)) {
      this.#deps.registerTool(this.#getPromptTool());
      this.#promptToolRegistered = true;
    }
  }

  /** Register a server's current tool set, recording the exposed names so a later
   * re-list or drop can cleanly unregister them. */
  #registerServerTools(entry: McpEntry, tools: McpToolSpec[], client: McpClient): void {
    // Two DISTINCT real tool names can sanitize to the same exposed name — within
    // ONE server (`db.get` and `db/get`) OR ACROSS servers whose keys collapse to
    // the same string (`gh.prod` and `gh_prod` both → `mcp__gh_prod__…`).
    // Registering both would let the second silently overwrite the first, leaving
    // one tool uncallable. Check the hub-wide live set (a fresh per-server set was
    // blind to cross-server clashes) and disambiguate the later one with a stable
    // hash of its (server, real-name) so the common readable name is preserved and
    // only clashes get a suffix.
    const names: string[] = [];
    for (const spec of tools) {
      let name = mcpToolName(entry.name, spec.name);
      if (this.#usedNames.has(name))
        name = withHashSuffix(name, djb2(`${entry.name}\u0000${spec.name}`));
      this.#usedNames.add(name);
      names.push(name);
      this.#deps.registerTool(toToolDefinition(entry.name, spec, client, name));
    }
    entry.toolNames = names;
    entry.toolCount = tools.length;
  }

  /** Unregister every tool currently exposed by a server (re-list / drop / close). */
  #unregisterServerTools(entry: McpEntry): void {
    for (const name of entry.toolNames) {
      // Free the exposed name in the hub-wide set too, so a re-list of THIS server
      // doesn't see its own just-removed names as cross-server collisions.
      this.#usedNames.delete(name);
      this.#deps.unregisterTool?.(name);
    }
    entry.toolNames = [];
    entry.toolCount = 0;
  }

  /** Wire live-update handlers for a connected client: re-list on tools/list_changed,
   * reconnect on transport close. No-ops for fakes/transports lacking the hooks. */
  #wire(entry: McpEntry, client: McpClient): void {
    client.onListChanged?.(() => void this.#refreshTools(entry.name));
    client.onResourcesChanged?.(() => void this.#refreshResources(entry.name));
    client.onPromptsChanged?.(() => void this.#refreshPrompts(entry.name));
    client.onClose?.(() => void this.#scheduleReconnect(entry.name));
  }

  /** Re-list a server's tools (tools/list_changed) and swap the registration. */
  async #refreshTools(name: string): Promise<void> {
    const entry = this.#entries.find((e) => e.name === name);
    if (!entry?.client || this.#closed) return;
    try {
      const tools = await withTimeout(
        entry.client.listTools(),
        entry.config.timeoutMs ?? this.#connectTimeoutMs,
        `re-listing tools for MCP server "${name}"`,
      );
      this.#unregisterServerTools(entry);
      this.#registerServerTools(entry, tools, entry.client);
      this.#log.info(`MCP server "${name}" tool list changed → ${tools.length} tools`);
    } catch (err) {
      this.#log.error(`MCP re-list for "${name}" failed: ${(err as Error).message}`);
    }
  }

  /** Re-list a server's resources (resources/list_changed) so the aggregate
   * read_mcp_resource tool reflects them without waiting for a reconnect. */
  async #refreshResources(name: string): Promise<void> {
    const entry = this.#entries.find((e) => e.name === name);
    if (!entry?.client?.listResources || this.#closed) return;
    try {
      const resources = await withTimeout(
        entry.client.listResources(),
        entry.config.timeoutMs ?? this.#connectTimeoutMs,
        `re-listing resources for MCP server "${name}"`,
      );
      entry.resources = resources;
      // A server that first advertises resources here still needs the aggregate tool.
      this.#ensureAggregateTools();
      this.#log.info(`MCP server "${name}" resource list changed → ${resources.length} resources`);
    } catch (err) {
      this.#log.error(`MCP resource re-list for "${name}" failed: ${(err as Error).message}`);
    }
  }

  /** Re-list a server's prompts (prompts/list_changed); same rationale as resources. */
  async #refreshPrompts(name: string): Promise<void> {
    const entry = this.#entries.find((e) => e.name === name);
    if (!entry?.client?.listPrompts || this.#closed) return;
    try {
      const prompts = await withTimeout(
        entry.client.listPrompts(),
        entry.config.timeoutMs ?? this.#connectTimeoutMs,
        `re-listing prompts for MCP server "${name}"`,
      );
      entry.prompts = prompts;
      this.#ensureAggregateTools();
      this.#log.info(`MCP server "${name}" prompt list changed → ${prompts.length} prompts`);
    } catch (err) {
      this.#log.error(`MCP prompt re-list for "${name}" failed: ${(err as Error).message}`);
    }
  }

  /** Re-dial a dropped server with exponential backoff, re-registering on success. */
  async #scheduleReconnect(name: string): Promise<void> {
    const entry = this.#entries.find((e) => e.name === name);
    if (!entry || this.#closed || this.#reconnecting.has(name)) return;
    this.#reconnecting.add(name);
    // The dropped connection's tools are stale — pull them until we're back.
    this.#unregisterServerTools(entry);
    entry.client = undefined;
    entry.error = "disconnected — reconnecting…";
    const { baseDelayMs, maxDelayMs, maxAttempts } = this.#reconnect;
    for (let attempt = 0; attempt < maxAttempts && !this.#closed; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(baseDelayMs * 2 ** attempt, maxDelayMs)));
      if (this.#closed) break;
      try {
        const { client, tools, resources, prompts } = await this.#connectAndList(
          name,
          entry.config,
        );
        // close() may have run while we were awaiting the (re)connect. If so, the
        // freshly-spawned transport (stdio child / HTTP connection) would leak —
        // #entries is already cleared and nothing will ever close it. Tear it down.
        if (this.#closed) {
          await client.close().catch(() => undefined);
          this.#reconnecting.delete(name);
          return;
        }
        entry.client = client;
        entry.resources = resources;
        entry.prompts = prompts;
        delete entry.error;
        this.#registerServerTools(entry, tools, client);
        // A server may first advertise resources/prompts on this reconnect; make
        // sure the aggregate tools are registered so they're actually reachable.
        this.#ensureAggregateTools();
        this.#wire(entry, client);
        this.#log.info(`MCP server "${name}" reconnected (${tools.length} tools)`);
        this.#reconnecting.delete(name);
        return;
      } catch (err) {
        this.#log.error(
          `MCP reconnect to "${name}" failed (attempt ${attempt + 1}/${maxAttempts}): ${(err as Error).message}`,
        );
      }
    }
    entry.error = "disconnected — reconnect gave up";
    this.#reconnecting.delete(name);
  }

  async #connectAndList(
    name: string,
    config: McpServer,
  ): Promise<{
    client: McpClient;
    tools: McpToolSpec[];
    resources: McpResource[];
    prompts: McpPrompt[];
  }> {
    const deadline = config.timeoutMs ?? this.#connectTimeoutMs;
    // Expand ${VAR}/${VAR:-default} across the server's connect-time strings before
    // dialing (a migrated Claude Code entry like `Authorization: "Bearer ${TOKEN}"`
    // must read the env var, not ship the literal / force inlined plaintext secrets).
    // Unresolved names are left LITERAL and surfaced on the MCP warning channel.
    const unresolved = new Set<string>();
    const resolved = expandServerConfig(config, unresolved);
    if (unresolved.size) {
      this.#log.warn(
        `MCP server "${name}": unresolved ${[...unresolved].map((v) => `\${${v}}`).join(", ")} ` +
          `— set the env var(s) or add a \${VAR:-default}; left literal.`,
      );
    }
    // Keep a handle on the raw connect promise: `withTimeout` only RACES it, so on
    // a connect-timeout the underlying attempt keeps running and may still resolve
    // later with a LIVE transport (a spawned stdio child / HTTP client). Without
    // closing that late arrival it orphans a process for the whole session.
    const connectP = this.#connect(name, resolved);
    const client = await withTimeout(
      connectP,
      deadline,
      `connecting to MCP server "${name}"`,
    ).catch((err) => {
      connectP.then((c) => c.close().catch(() => undefined)).catch(() => undefined);
      throw err;
    });
    try {
      const tools = await withTimeout(
        client.listTools(),
        deadline,
        `listing tools for MCP server "${name}"`,
      );
      // Resources + prompts are optional capabilities — a server that doesn't
      // support them throws "method not found"; treat that as "none". Each
      // enumeration runs under the SAME connect deadline: a server that answers
      // tools/list fast but STALLS on resources/list must not block boot past its
      // configured timeout (a plain `.catch` swallows a rejection, not a hang).
      const resources = client.listResources
        ? await withTimeout(
            client.listResources(),
            deadline,
            `listing resources for MCP server "${name}"`,
          ).catch(() => [] as McpResource[])
        : [];
      const prompts = client.listPrompts
        ? await withTimeout(
            client.listPrompts(),
            deadline,
            `listing prompts for MCP server "${name}"`,
          ).catch(() => [] as McpPrompt[])
        : [];
      return { client, tools, resources, prompts };
    } catch (err) {
      // We connected but couldn't enumerate — don't leak the transport.
      await client.close().catch(() => undefined);
      throw err;
    }
  }

  /** Every resource across connected servers (for `read_mcp_resource` + status). */
  resources(): (McpResource & { server: string })[] {
    return this.#entries.flatMap((e) => e.resources.map((r) => ({ ...r, server: e.name })));
  }

  /** Every prompt across connected servers (the engine registers these as commands). */
  prompts(): (McpPrompt & { server: string })[] {
    return this.#entries.flatMap((e) => e.prompts.map((p) => ({ ...p, server: e.name })));
  }

  /** Read a resource by uri (optionally scoped to a server). */
  async readResource(
    uri: string,
    server?: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<string> {
    const entry = this.#entries.find(
      (e) =>
        e.client?.readResource &&
        (server ? e.name === server : e.resources.some((r) => r.uri === uri)),
    );
    if (!entry?.client?.readResource) {
      throw new Error(`no MCP server provides resource "${uri}"`);
    }
    const res = await entry.client.readResource(uri, opts);
    return capMcpOutput(renderContent(res.content));
  }

  /** Render a server prompt to text by name + args. */
  async getPrompt(
    server: string,
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<string> {
    const entry = this.#entries.find((e) => e.name === server);
    if (!entry?.client?.getPrompt)
      throw new Error(`MCP server "${server}" has no prompt "${name}"`);
    const res = await entry.client.getPrompt(name, args, opts);
    return capMcpOutput(renderContent(res.content));
  }

  /** The read_mcp_resource tool: list resources, or read one by uri. */
  #readResourceTool(): ToolDefinition {
    return {
      name: "read_mcp_resource",
      description:
        "List or read resources exposed by connected MCP servers. Call with no arguments to list available resources (uri + description); pass a `uri` (and optional `server`) to read one's contents.",
      inputSchema: {
        type: "object",
        properties: {
          uri: { type: "string", description: "Resource uri to read; omit to list all resources." },
          server: { type: "string", description: "Restrict to a specific server (optional)." },
        },
      },
      readOnly: true,
      // Reaches an external MCP server — that IS egress. Flag it so the gate
      // consults the rules (readOnly alone would short-circuit the gate on
      // `(!def.readOnly || def.network)`; a deny/ask rule on `read_mcp_resource`
      // must still fire). Mirrors the per-tool `network:true` in toToolDefinition.
      network: true,
      execute: async (args, ctx) => {
        const { uri, server } = (args ?? {}) as { uri?: string; server?: string };
        if (!uri) {
          const list = this.resources();
          if (!list.length) return { output: "No MCP resources available." };
          const lines = list.map(
            (r) =>
              `- ${r.uri}${r.name ? ` (${r.name})` : ""} — ${r.description ?? r.mimeType ?? "resource"} [${r.server}]`,
          );
          return { output: `MCP resources:\n${lines.join("\n")}` };
        }
        try {
          // Thread the turn's abort signal + a per-call deadline so a hung read
          // is cancellable by Esc and bounded (parity with MCP tool calls).
          return {
            output: await this.readResource(uri, server, {
              signal: ctx.abortSignal,
              timeoutMs: MCP_CALL_TIMEOUT_MS,
            }),
          };
        } catch (err) {
          return { output: (err as Error).message, isError: true };
        }
      },
    };
  }

  /** The get_mcp_prompt tool: list server prompts, or render one by name + args. */
  #getPromptTool(): ToolDefinition {
    return {
      name: "get_mcp_prompt",
      description:
        "List or render prompt templates exposed by connected MCP servers. Call with no `name` to list available prompts; pass `server` + `name` (and optional `args`) to render one into text you can use.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "The server the prompt belongs to." },
          name: { type: "string", description: "Prompt name to render; omit to list prompts." },
          args: { type: "object", description: "Arguments for the prompt template (optional)." },
        },
      },
      readOnly: true,
      // Reaches an external MCP server — egress. Flag it so a deny/ask rule on
      // `get_mcp_prompt` fires (see read_mcp_resource / toToolDefinition).
      network: true,
      execute: async (input, ctx) => {
        const { server, name, args } = (input ?? {}) as {
          server?: string;
          name?: string;
          args?: Record<string, unknown>;
        };
        if (!name) {
          const list = this.prompts();
          if (!list.length) return { output: "No MCP prompts available." };
          const lines = list.map((p) => {
            const argNames = (p.arguments ?? []).map((a) => a.name).join(", ");
            return `- ${p.name}${argNames ? `(${argNames})` : ""} — ${p.description ?? "prompt"} [${p.server}]`;
          });
          return { output: `MCP prompts:\n${lines.join("\n")}` };
        }
        if (!server) return { output: "Pass `server` to render a prompt.", isError: true };
        try {
          // Thread abort + deadline so a wedged prompt render is cancellable/bounded.
          return {
            output: await this.getPrompt(server, name, args ?? {}, {
              signal: ctx.abortSignal,
              timeoutMs: MCP_CALL_TIMEOUT_MS,
            }),
          };
        } catch (err) {
          return { output: (err as Error).message, isError: true };
        }
      },
    };
  }

  /** Connection status for every configured server (for `/mcp`, `/doctor`).
   * `connected` is re-read live from the client so a server whose transport has
   * since dropped is reported as down, not as "connected, N tools". */
  status(): McpServerStatus[] {
    return this.#entries.map((e) => ({
      name: e.name,
      connected: e.client ? (e.client.isConnected?.() ?? true) : false,
      toolCount: e.toolCount,
      resourceCount: e.resources.length,
      promptCount: e.prompts.length,
      ...(e.error ? { error: e.error } : {}),
    }));
  }

  /** Close all connected clients. Sets `#closed` first so a client's own onclose
   * (fired during shutdown) can't kick off a reconnect loop. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(this.#entries.map((e) => e.client?.close().catch(() => undefined)));
    this.#entries = [];
  }
}

/** Expand `${VAR}` and `${VAR:-default}` in one string against `env`. A resolved
 * var wins; an absent var falls back to its `:-default`; an absent var with NO
 * default is LEFT LITERAL (and its name recorded in `unresolved`) — expanding to
 * empty would silently ship a broken value (e.g. `Bearer `). A bare `$` without
 * braces is untouched (the regex only matches `${…}`). */
function expandVars(
  input: string,
  env: Record<string, string | undefined>,
  unresolved: Set<string>,
): string {
  return input.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (whole, name: string, def?: string) => {
      const val = env[name];
      if (val !== undefined) return val;
      if (def !== undefined) return def;
      unresolved.add(name);
      return whole;
    },
  );
}

/** Return a copy of a server config with `${VAR}`/`${VAR:-default}` expanded over
 * every user-supplied connect-time string — command, each arg, each env value,
 * url, each header value. Unresolved (no-default) var names collect in
 * `unresolved` so the hub can warn once per server. */
export function expandServerConfig(config: McpServer, unresolved: Set<string>): McpServer {
  const env = process.env;
  const ex = (s: string) => expandVars(s, env, unresolved);
  const mapVals = (rec: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, ex(v)]));
  if ("command" in config) {
    return {
      ...config,
      command: ex(config.command),
      ...(config.args ? { args: config.args.map(ex) } : {}),
      ...(config.env ? { env: mapVals(config.env) } : {}),
    };
  }
  return {
    ...config,
    url: ex(config.url),
    ...(config.headers ? { headers: mapVals(config.headers) } : {}),
  };
}

/**
 * Build the function name exposed to the model for an MCP tool. Hosted providers
 * (OpenAI, DeepSeek, xAI, Anthropic, …) require tool names to match
 * `^[a-zA-Z0-9_-]+$` and be ≤ 64 chars, but MCP server keys and tool names are
 * arbitrary (e.g. `github.search`). So we sanitize disallowed characters to `_`
 * and, when the result is too long, truncate with a short stable hash to keep it
 * unique. The *real* MCP tool name is kept separately for `callTool`.
 */
export function mcpToolName(server: string, toolName: string): string {
  const raw = `mcp__${server}__${toolName}`;
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (sanitized.length <= 64) return sanitized;
  // Full 32-bit hash in base36 (≤7 chars) — keep all entropy so truncated names
  // that share a prefix stay distinct.
  return withHashSuffix(sanitized, djb2(raw));
}

/** Append a stable base36 hash suffix, trimming the base to keep ≤ 64 chars. */
function withHashSuffix(sanitized: string, hash: number): string {
  const suffix = `_${hash.toString(36)}`;
  return `${sanitized.slice(0, 64 - suffix.length)}${suffix}`;
}

/** Map the hub's `{signal, timeoutMs}` onto the SDK's request options
 * (`{signal, timeout}`), omitting absent fields so the SDK keeps its defaults. */
function mcpRequestOptions(opts?: { signal?: AbortSignal; timeoutMs?: number }): {
  signal?: AbortSignal;
  timeout?: number;
} {
  return {
    ...(opts?.signal ? { signal: opts.signal } : {}),
    ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  };
}

/** Tiny deterministic string hash (djb2) — for unique truncation suffixes. */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Adapt one MCP tool spec into a gated ToolDefinition bound to its client. */
export function toToolDefinition(
  server: string,
  spec: McpToolSpec,
  client: McpClient,
  /** Pre-resolved exposed name (collision-disambiguated by the caller); defaults
   * to the plain sanitized name for standalone use. */
  exposedName: string = mcpToolName(server, spec.name),
): ToolDefinition {
  return {
    // Exposed name is sanitized for provider compatibility; `spec.name` (the real
    // MCP tool name) is what we hand back to the server in `callTool`.
    name: exposedName,
    description: spec.description ?? `MCP tool "${spec.name}" from "${server}".`,
    inputSchema: spec.inputSchema ?? { type: "object", properties: {} },
    // Honor the server's readOnlyHint: a genuinely read-only MCP tool works in
    // plan mode. Default conservative (false).
    readOnly: spec.annotations?.readOnlyHint === true,
    // Every MCP tool reaches an external server — that IS network egress. Flag it
    // so the permission gate always consults the rules (a `readOnlyHint:true` tool
    // must NOT short-circuit the gate on server-supplied metadata: a deny/ask rule
    // on `mcp__web__fetch` has to be able to fire). A read-only MCP tool keeps the
    // frictionless allow-default (no prompt) but stays governable; a mutating one
    // gets the interactive prompt.
    network: true,
    execute: async (args, ctx) => {
      const res = await client.callTool(spec.name, args, {
        signal: ctx.abortSignal,
        timeoutMs: MCP_CALL_TIMEOUT_MS,
      });
      return { output: capMcpOutput(renderContent(res.content)), isError: res.isError };
    },
  };
}

/** ~byte size of a base64 string, for a placeholder (no decoding). */
function approxBase64Bytes(b64: string): number {
  const len = b64.replace(/=+$/, "").length;
  return Math.floor((len * 3) / 4);
}

/** Render one MCP content part to text, replacing binary payloads (image/audio/
 * blob resources) with a compact placeholder instead of dumping base64. */
function renderPart(p: unknown): string {
  const part = p as {
    type?: string;
    text?: string;
    data?: string;
    blob?: string;
    uri?: string;
    mimeType?: string;
    resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
  };
  if (part?.type === "text" && typeof part.text === "string") return part.text;
  if (part?.type === "image" || part?.type === "audio") {
    const mime = part.mimeType ? ` ${part.mimeType}` : "";
    const size = part.data ? `, ~${approxBase64Bytes(part.data)} bytes` : "";
    return `[${part.type}${mime}${size} omitted]`;
  }
  if (part?.type === "resource" && part.resource) {
    const r = part.resource;
    if (typeof r.text === "string") return r.text;
    if (r.blob) {
      const mime = r.mimeType ? ` ${r.mimeType}` : "";
      return `[resource ${r.uri ?? ""}${mime}, ~${approxBase64Bytes(r.blob)} bytes omitted]`;
    }
    return `[resource ${r.uri ?? ""}]`;
  }
  // `resources/read` contents items have NO `type` discriminator — they are bare
  // `{ uri, mimeType, text }` (text resource) or `{ uri, mimeType, blob }` (binary).
  // Render text verbatim; summarize a binary blob (mime + byte length) rather than
  // dump megabytes of raw base64 into the prompt (blows context, 400s the next turn).
  if (typeof part?.text === "string") return part.text;
  if (typeof part?.blob === "string") {
    const mime = part.mimeType ? ` ${part.mimeType}` : "";
    return `[resource ${part.uri ?? ""}${mime}, ~${approxBase64Bytes(part.blob)} bytes omitted]`;
  }
  return JSON.stringify(p);
}

/** Flatten MCP tool-result content into text the model can read. */
export function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(renderPart).join("\n");
  return JSON.stringify(content ?? "");
}

/**
 * Default transport: lazily import the official `@modelcontextprotocol/sdk`
 * (an optional peer dep). Throws a clear, actionable error if it's not
 * installed — the hub catches it and skips the server.
 */
const defaultConnect: McpConnect = async (name, config) => {
  let ClientCtor: new (info: { name: string; version: string }) => McpSdkClient;
  let makeTransport: () => Promise<unknown>;
  // Non-literal specifiers so tsc does not try to resolve the optional peer dep.
  const sdk = "@modelcontextprotocol/sdk/client";
  try {
    const clientMod = (await import(`${sdk}/index.js`)) as {
      Client: typeof ClientCtor;
    };
    ClientCtor = clientMod.Client;
    if ("command" in config) {
      const stdioMod = (await import(`${sdk}/stdio.js`)) as {
        StdioClientTransport: new (o: unknown) => unknown;
      };
      makeTransport = async () =>
        new stdioMod.StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          // Merge over the inherited environment so the server still gets PATH /
          // HOME etc.; `config.env` only adds/overrides specific vars.
          env: { ...process.env, ...(config.env ?? {}) },
          ...(config.cwd ? { cwd: config.cwd } : {}),
        });
    } else {
      // Transport options: static headers (Authorization / API keys) and/or an
      // OAuth 2.1 provider so authenticated remote MCP servers can connect.
      const options: { requestInit?: { headers: Record<string, string> }; authProvider?: unknown } =
        {};
      if (config.headers) options.requestInit = { headers: config.headers };
      if (config.oauth) options.authProvider = createMcpOAuthProvider(name, config.oauth);
      const url = new URL(config.url);
      // Streamable HTTP is the modern default transport; "sse" selects the legacy one.
      if (config.transport === "sse") {
        const sseMod = (await import(`${sdk}/sse.js`)) as {
          SSEClientTransport: new (url: URL, o?: unknown) => unknown;
        };
        makeTransport = async () => new sseMod.SSEClientTransport(url, options);
      } else {
        const httpMod = (await import(`${sdk}/streamableHttp.js`)) as {
          StreamableHTTPClientTransport: new (url: URL, o?: unknown) => unknown;
        };
        makeTransport = async () => new httpMod.StreamableHTTPClientTransport(url, options);
      }
    }
  } catch (err) {
    throw new Error(
      `MCP requires the "@modelcontextprotocol/sdk" package (bun add @modelcontextprotocol/sdk): ${
        (err as Error).message
      }`,
    );
  }

  const client = new ClientCtor({ name: "vibecodr", version: "0.0.0" });
  // Track live transport health + live-update hooks. The SDK fires onclose/onerror
  // on a drop (so `/mcp`/`/doctor` stop reporting a dead server up, and the hub
  // reconnects) and routes un-handled notifications to fallbackNotificationHandler
  // (so tools/list_changed triggers a re-list).
  let connected = true;
  const listChangedCbs: (() => void)[] = [];
  const resourcesChangedCbs: (() => void)[] = [];
  const promptsChangedCbs: (() => void)[] = [];
  const closeCbs: (() => void)[] = [];
  const lifecycle = client as McpSdkClient & {
    onclose?: () => void;
    onerror?: (err: unknown) => void;
    fallbackNotificationHandler?: (n: { method?: string }) => Promise<void>;
  };
  lifecycle.onclose = () => {
    connected = false;
    for (const cb of closeCbs) cb();
  };
  // The SDK fires onerror on TRANSIENT/recoverable events too (a malformed SSE
  // chunk, a stream read hiccup) while the connection stays alive, so it is NOT a
  // durable disconnect signal. Latching connected=false here would report a
  // still-working server down forever — nothing resets it, and only onclose
  // triggers a reconnect. Rely on onclose for the down transition.
  lifecycle.onerror = () => {};
  lifecycle.fallbackNotificationHandler = async (n) => {
    if (n?.method === "notifications/tools/list_changed") for (const cb of listChangedCbs) cb();
    else if (n?.method === "notifications/resources/list_changed")
      for (const cb of resourcesChangedCbs) cb();
    else if (n?.method === "notifications/prompts/list_changed")
      for (const cb of promptsChangedCbs) cb();
  };
  await client.connect(await makeTransport());
  return {
    async listTools() {
      const res = await client.listTools();
      return (res.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as JsonSchema | undefined,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
    },
    async callTool(name, args, opts) {
      // Thread the turn's abort signal + a per-call deadline into the SDK so
      // Esc actually cancels a hung MCP tool (it used to be uncancellable) and
      // a wedged server can't hold the turn hostage.
      const res = await client.callTool(
        {
          name,
          arguments: (args ?? {}) as Record<string, unknown>,
        },
        undefined,
        mcpRequestOptions(opts),
      );
      return { content: res.content, isError: Boolean(res.isError) };
    },
    async listResources() {
      const res = await client.listResources();
      return (res.resources ?? []).map((r) => ({
        uri: r.uri,
        ...(r.name ? { name: r.name } : {}),
        ...(r.description ? { description: r.description } : {}),
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
      }));
    },
    async readResource(uri, opts) {
      // Thread abort + deadline into the SDK exactly like callTool, so Esc cancels
      // a hung read and a wedged server can't hold the turn past the deadline.
      const res = await client.readResource({ uri }, mcpRequestOptions(opts));
      return { content: res.contents };
    },
    async listPrompts() {
      const res = await client.listPrompts();
      return (res.prompts ?? []).map((p) => ({
        name: p.name,
        ...(p.description ? { description: p.description } : {}),
        ...(p.arguments ? { arguments: p.arguments } : {}),
      }));
    },
    async getPrompt(name, args, opts) {
      const res = await client.getPrompt({ name, arguments: args }, mcpRequestOptions(opts));
      // Prompt messages → flatten each message's content for the model.
      const content = (res.messages ?? []).map((m) => m.content);
      return { content };
    },
    isConnected: () => connected,
    onListChanged(cb) {
      listChangedCbs.push(cb);
    },
    onResourcesChanged(cb) {
      resourcesChangedCbs.push(cb);
    },
    onPromptsChanged(cb) {
      promptsChangedCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    async close() {
      connected = false;
      await client.close();
    },
  };
};

/** The slice of the official SDK client the default transport uses. */
interface McpSdkClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{
    tools?: {
      name: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: { readOnlyHint?: boolean };
    }[];
  }>;
  callTool(
    req: {
      name: string;
      arguments: Record<string, unknown>;
    },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ content: unknown; isError?: boolean }>;
  listResources(): Promise<{
    resources?: { uri: string; name?: string; description?: string; mimeType?: string }[];
  }>;
  readResource(
    req: { uri: string },
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ contents: unknown }>;
  listPrompts(): Promise<{
    prompts?: {
      name: string;
      description?: string;
      arguments?: { name: string; description?: string; required?: boolean }[];
    }[];
  }>;
  getPrompt(
    req: {
      name: string;
      arguments: Record<string, unknown>;
    },
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ messages?: { content: unknown }[] }>;
  close(): Promise<void>;
}
