import {
  createLogger,
  type JsonSchema,
  type Logger,
  type ToolDefinition,
} from "@vibe/shared";
import type { McpServer } from "@vibe/config";

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

/** An MCP prompt a server exposes (surfaced as a slash command). */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** A connected MCP server, reduced to what the hub needs. */
export interface McpClient {
  listTools(): Promise<McpToolSpec[]>;
  callTool(
    name: string,
    args: unknown,
  ): Promise<{ content: unknown; isError?: boolean }>;
  /** List the server's resources (optional capability). */
  listResources?(): Promise<McpResource[]>;
  /** Read a resource's contents by uri (optional capability). */
  readResource?(uri: string): Promise<{ content: unknown }>;
  /** List the server's prompts (optional capability). */
  listPrompts?(): Promise<McpPrompt[]>;
  /** Render a prompt to text by name + args (optional capability). */
  getPrompt?(name: string, args: Record<string, unknown>): Promise<{ content: unknown }>;
  /** Live transport health — false once the connection drops (so `/mcp` and
   * `/doctor` stop reporting a crashed server as healthy). Optional; absent =
   * assumed connected. */
  isConnected?(): boolean;
  close(): Promise<void>;
}

/** Connects to an MCP server (injectable so the hub is testable offline). */
export type McpConnect = (name: string, config: McpServer) => Promise<McpClient>;

/** Default per-server connect+list-tools deadline so one hung server can't block boot. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export interface McpHubDeps {
  registerTool: (def: ToolDefinition) => void;
  connect?: McpConnect;
  logger?: Logger;
  /** Per-server connect timeout (ms). Default 15000. */
  connectTimeoutMs?: number;
}

/** Reject if `p` doesn't settle within `ms` (so a hung connect is bounded). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms ${what}`)),
      ms,
    );
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
  client?: McpClient;
  toolCount: number;
  resources: McpResource[];
  prompts: McpPrompt[];
  error?: string;
}

export class McpHub {
  #deps: McpHubDeps;
  #connect: McpConnect;
  #log: Logger;
  #connectTimeoutMs: number;
  #entries: McpEntry[] = [];

  constructor(deps: McpHubDeps) {
    this.#deps = deps;
    this.#connect = deps.connect ?? defaultConnect;
    this.#log = deps.logger ?? createLogger("mcp");
    this.#connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  /**
   * Connect every server and register its tools. Servers connect in PARALLEL,
   * each under a wall-clock deadline, so one slow/hung stdio server can't block
   * CLI startup for N×timeout. Safe to call once at boot. Registration + status
   * preserve config order regardless of which connects finish first.
   */
  async start(servers: Record<string, McpServer>): Promise<void> {
    const entries = Object.entries(servers);
    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.#connectAndList(name, config)),
    );
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i]![0];
      const r = results[i]!;
      if (r.status === "fulfilled") {
        const { client, tools, resources, prompts } = r.value;
        for (const spec of tools) {
          this.#deps.registerTool(toToolDefinition(name, spec, client));
        }
        this.#entries.push({ name, client, toolCount: tools.length, resources, prompts });
        this.#log.info(
          `connected MCP server "${name}" (${tools.length} tools` +
            `${resources.length ? `, ${resources.length} resources` : ""}` +
            `${prompts.length ? `, ${prompts.length} prompts` : ""})`,
        );
      } else {
        const message = (r.reason as Error).message;
        this.#entries.push({ name, toolCount: 0, resources: [], prompts: [], error: message });
        this.#log.error(`MCP server "${name}" failed: ${message}`);
      }
    }
    // Register read_mcp_resource / get_mcp_prompt once if any server exposes them.
    if (this.#entries.some((e) => e.resources.length)) {
      this.#deps.registerTool(this.#readResourceTool());
    }
    if (this.#entries.some((e) => e.prompts.length)) {
      this.#deps.registerTool(this.#getPromptTool());
    }
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
    const client = await withTimeout(
      this.#connect(name, config),
      this.#connectTimeoutMs,
      `connecting to MCP server "${name}"`,
    );
    try {
      const tools = await withTimeout(
        client.listTools(),
        this.#connectTimeoutMs,
        `listing tools for MCP server "${name}"`,
      );
      // Resources + prompts are optional capabilities — a server that doesn't
      // support them throws "method not found"; treat that as "none".
      const resources = client.listResources
        ? await client.listResources().catch(() => [] as McpResource[])
        : [];
      const prompts = client.listPrompts
        ? await client.listPrompts().catch(() => [] as McpPrompt[])
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
  async readResource(uri: string, server?: string): Promise<string> {
    const entry = this.#entries.find(
      (e) => e.client?.readResource && (server ? e.name === server : e.resources.some((r) => r.uri === uri)),
    );
    if (!entry?.client?.readResource) {
      throw new Error(`no MCP server provides resource "${uri}"`);
    }
    const res = await entry.client.readResource(uri);
    return renderContent(res.content);
  }

  /** Render a server prompt to text by name + args. */
  async getPrompt(server: string, name: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.#entries.find((e) => e.name === server);
    if (!entry?.client?.getPrompt) throw new Error(`MCP server "${server}" has no prompt "${name}"`);
    const res = await entry.client.getPrompt(name, args);
    return renderContent(res.content);
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
      execute: async (args) => {
        const { uri, server } = (args ?? {}) as { uri?: string; server?: string };
        if (!uri) {
          const list = this.resources();
          if (!list.length) return { output: "No MCP resources available." };
          const lines = list.map(
            (r) => `- ${r.uri}${r.name ? ` (${r.name})` : ""} — ${r.description ?? r.mimeType ?? "resource"} [${r.server}]`,
          );
          return { output: `MCP resources:\n${lines.join("\n")}` };
        }
        try {
          return { output: await this.readResource(uri, server) };
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
      execute: async (input) => {
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
          return { output: await this.getPrompt(server, name, args ?? {}) };
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

  /** Close all connected clients. */
  async close(): Promise<void> {
    await Promise.all(
      this.#entries.map((e) => e.client?.close().catch(() => undefined)),
    );
    this.#entries = [];
  }
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
  const hash = djb2(raw).toString(36);
  return `${sanitized.slice(0, 64 - hash.length - 1)}_${hash}`;
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
): ToolDefinition {
  return {
    // Exposed name is sanitized for provider compatibility; `spec.name` (the real
    // MCP tool name) is what we hand back to the server in `callTool`.
    name: mcpToolName(server, spec.name),
    description: spec.description ?? `MCP tool "${spec.name}" from "${server}".`,
    inputSchema: spec.inputSchema ?? { type: "object", properties: {} },
    // Honor the server's readOnlyHint: a genuinely read-only MCP tool skips the
    // permission gate and works in plan mode. Default conservative (false).
    readOnly: spec.annotations?.readOnlyHint === true,
    execute: async (args) => {
      const res = await client.callTool(spec.name, args);
      return { output: renderContent(res.content), isError: res.isError };
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
const defaultConnect: McpConnect = async (_name, config) => {
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
        });
    } else {
      // Forward configured headers (Authorization / API keys) so authenticated
      // remote MCP servers can connect.
      const options = config.headers ? { requestInit: { headers: config.headers } } : undefined;
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
  // Track live transport health: the SDK fires onclose/onerror when the
  // connection drops, so `/mcp` and `/doctor` stop reporting a dead server up.
  let connected = true;
  const lifecycle = client as McpSdkClient & {
    onclose?: () => void;
    onerror?: (err: unknown) => void;
  };
  lifecycle.onclose = () => {
    connected = false;
  };
  lifecycle.onerror = () => {
    connected = false;
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
    async callTool(name, args) {
      const res = await client.callTool({
        name,
        arguments: (args ?? {}) as Record<string, unknown>,
      });
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
    async readResource(uri) {
      const res = await client.readResource({ uri });
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
    async getPrompt(name, args) {
      const res = await client.getPrompt({ name, arguments: args });
      // Prompt messages → flatten each message's content for the model.
      const content = (res.messages ?? []).map((m) => m.content);
      return { content };
    },
    isConnected: () => connected,
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
  callTool(req: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content: unknown; isError?: boolean }>;
  listResources(): Promise<{
    resources?: { uri: string; name?: string; description?: string; mimeType?: string }[];
  }>;
  readResource(req: { uri: string }): Promise<{ contents: unknown }>;
  listPrompts(): Promise<{
    prompts?: {
      name: string;
      description?: string;
      arguments?: { name: string; description?: string; required?: boolean }[];
    }[];
  }>;
  getPrompt(req: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ messages?: { content: unknown }[] }>;
  close(): Promise<void>;
}
