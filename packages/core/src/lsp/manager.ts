import type { LspConfig } from "@vibe/config";
import type { Logger } from "@vibe/shared";
import type { Diagnostics, LspStatus } from "../diagnostics.ts";
import { languageForPath, resolveServer, type WhichFn } from "./registry.ts";
import { LspClient, defaultLspSpawn, withTimeout } from "./client.ts";

/**
 * `LspDiagnostics` — the multi-language arm of the diagnostics seam. It lazy-
 * spawns ONE language server per filetype on first diagnose, bounds every
 * per-diagnose call by a deadline (a slow/heavy server never blocks an edit —
 * timeout → undefined, advisory), decouples first-spawn (initialize) latency from
 * that deadline (a heavy server starts in the BACKGROUND and is ready for the next
 * edit rather than hanging this one), restarts a crashed server with bounded
 * backoff before giving up (mirrors the MCP hub), and idle-shuts-down unused
 * servers. Every failure degrades to undefined, never a false "clean".
 */

/** The slice of `LspClient` the manager drives (injectable for tests). */
export interface ManagedClient {
  start(): Promise<void>;
  diagnose(absPath: string, timeoutMs: number): Promise<string | undefined>;
  dispose(): void;
  onExit(cb: (code: number) => void): void;
}

/** Everything needed to construct a client for one resolved server. */
export interface ClientSpec {
  command: string;
  args: string[];
  languageId: string;
  rootPath: string;
  initializeTimeoutMs: number;
  log?: Logger;
}

export type LspClientFactory = (spec: ClientSpec) => ManagedClient;

export interface LspDiagnosticsOptions {
  config: LspConfig;
  /** Workspace root getter (the server's rootUri). Read lazily at spawn time. */
  workspaceRoot: () => string;
  log?: Logger;
  /** PATH probe (default `Bun.which`). Injectable so tests never touch PATH. */
  which?: WhichFn;
  /** Client constructor (default: a real `LspClient` over stdio). */
  clientFactory?: LspClientFactory;
  /** First-spawn handshake deadline (ms), decoupled from the per-diagnose one. */
  initializeTimeoutMs?: number;
  /** Base restart backoff (ms), exponential per attempt. 0 in tests. */
  restartBackoffMs?: number;
  /** Max spawn attempts before a language gives up (bounded crash-restart). */
  maxRestarts?: number;
  /** Clock (default `Date.now`), injectable for deterministic backoff tests. */
  now?: () => number;
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const MAX_RESTART_BACKOFF_MS = 30_000;
const DEFAULT_MAX_RESTARTS = 3;

/** Per-language server lifecycle. State is DERIVED for `/doctor` (no field to
 * keep in sync): missing > crashed > running > starting > idle. */
interface LangEntry {
  language: string;
  /** Resolved server command (absent → no candidate binary; `missing`). */
  command?: string;
  args: string[];
  languageId: string;
  missing: boolean;
  client?: ManagedClient;
  /** In-flight background start (the guard against stacking spawns). */
  starting?: Promise<ManagedClient | undefined>;
  /** The client whose start() is still in flight — tracked SYNCHRONOUSLY (before
   * the await) so dispose() can tear down a server stuck mid-initialize instead
   * of leaking its child process. */
  startingClient?: ManagedClient;
  /** The client currently being torn down intentionally (idle/dispose) — its
   * exit is NOT counted as a crash. */
  stoppingClient?: ManagedClient;
  restarts: number;
  gaveUp: boolean;
  /** Earliest time (ms) a re-spawn is allowed after a crash (backoff). */
  nextRetryAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export class LspDiagnostics implements Diagnostics {
  #config: LspConfig;
  #workspaceRoot: () => string;
  #log: Logger | undefined;
  #which: WhichFn;
  #factory: LspClientFactory;
  #initTimeoutMs: number;
  #backoffMs: number;
  #maxRestarts: number;
  #now: () => number;
  #diagnoseTimeoutMs: number;
  #idleShutdownMs: number;
  #entries = new Map<string, LangEntry>();
  #disposed = false;

  constructor(opts: LspDiagnosticsOptions) {
    this.#config = opts.config;
    this.#workspaceRoot = opts.workspaceRoot;
    this.#log = opts.log;
    this.#which = opts.which ?? ((cmd) => Bun.which(cmd));
    this.#factory =
      opts.clientFactory ?? ((spec) => new LspClient({ ...spec, spawn: defaultLspSpawn }));
    this.#initTimeoutMs = opts.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.#backoffMs = opts.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.#maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.#now = opts.now ?? Date.now;
    this.#diagnoseTimeoutMs = opts.config.timeoutMs;
    this.#idleShutdownMs = opts.config.idleShutdownMs;
  }

  async available(): Promise<boolean> {
    return this.#config.enabled;
  }

  async diagnose(absPath: string): Promise<string | undefined> {
    if (this.#disposed || !this.#config.enabled) return undefined;
    const lang = languageForPath(absPath);
    if (!lang) return undefined;
    const entry = this.#resolveEntry(lang);
    if (!entry || entry.missing || entry.gaveUp) return undefined;

    let client = entry.client;
    if (!client) {
      // Don't hammer a just-crashed server — honor the restart backoff window.
      if (this.#now() < entry.nextRetryAt) return undefined;
      // Kick off (or join) a BACKGROUND start, but never block the edit past the
      // per-diagnose deadline: a heavy first-spawn returns undefined now and is
      // ready for the next edit.
      const starting = entry.starting ?? this.#ensureClient(entry);
      client = await Promise.race([starting, this.#delay(this.#diagnoseTimeoutMs).then(() => undefined)]);
      if (!client) return undefined;
    }
    this.#armIdle(entry); // re-arm on use
    // Bound the whole round-trip: the client enforces its own deadline too, but
    // this guards a wedged write to a half-dead pipe as well (→ undefined).
    try {
      const result = await withTimeout(
        client.diagnose(absPath, this.#diagnoseTimeoutMs),
        this.#diagnoseTimeoutMs,
        `lsp diagnose ${entry.language}`,
      );
      // A completed round-trip is the ONLY proof the server is genuinely usable,
      // so clear the crash budget here rather than on a mere clean init — a
      // server that inits fine but dies on every use keeps accumulating toward
      // the give-up bound instead of resetting each respawn and churning forever.
      entry.restarts = 0;
      return result;
    } catch {
      return undefined;
    }
  }

  status(): LspStatus[] {
    const out: LspStatus[] = [...this.#entries.values()].map((e) => ({
      language: e.language,
      ...(e.command ? { command: e.command } : {}),
      state: e.missing
        ? ("missing" as const)
        : e.gaveUp
          ? ("crashed" as const)
          : e.client
            ? ("running" as const)
            : e.starting
              ? ("starting" as const)
              : ("idle" as const),
    }));
    // Surface configured-but-missing servers the model never happened to touch —
    // a misconfigured `lsp.servers.<lang>.command` shows up in /doctor up front.
    const seen = new Set(this.#entries.keys());
    for (const [lang, override] of Object.entries(this.#config.servers)) {
      if (seen.has(lang) || override.enabled === false) continue;
      const resolved = resolveServer(lang, this.#config, this.#which);
      out.push(
        resolved
          ? { language: lang, command: resolved.command, state: "idle" }
          : { language: lang, state: "missing" },
      );
    }
    return out;
  }

  dispose(): void {
    // Set first so an in-flight background start disposes its client the moment
    // it finishes (the `this.#disposed` guard in #ensureClient) rather than leak.
    this.#disposed = true;
    for (const entry of this.#entries.values()) {
      this.#clearIdle(entry);
      // Tear down a ready client OR one still mid-initialize — the latter's
      // start() may never resolve, so relying on the #ensureClient disposed-guard
      // alone would leak its child process past shutdown.
      const client = entry.client ?? entry.startingClient;
      if (client) {
        entry.stoppingClient = client; // its exit is intentional, not a crash
        entry.client = undefined;
        entry.startingClient = undefined;
        client.dispose();
      }
    }
  }

  // --- internals -----------------------------------------------------------

  /** Look up (creating on first sight) the entry for a language. A language with
   * no resolvable server is remembered as `missing` (for /doctor) and never
   * retried within the session. */
  #resolveEntry(lang: string): LangEntry {
    const existing = this.#entries.get(lang);
    if (existing) return existing;
    const resolved = resolveServer(lang, this.#config, this.#which);
    const entry: LangEntry = resolved
      ? {
          language: lang,
          command: resolved.command,
          args: resolved.args,
          languageId: resolved.languageId,
          missing: false,
          restarts: 0,
          gaveUp: false,
          nextRetryAt: 0,
        }
      : { language: lang, args: [], languageId: lang, missing: true, restarts: 0, gaveUp: false, nextRetryAt: 0 };
    this.#entries.set(lang, entry);
    return entry;
  }

  #ensureClient(entry: LangEntry): Promise<ManagedClient | undefined> {
    const client = this.#factory({
      command: entry.command!,
      args: entry.args,
      languageId: entry.languageId,
      rootPath: this.#workspaceRoot(),
      initializeTimeoutMs: this.#initTimeoutMs,
      ...(this.#log ? { log: this.#log } : {}),
    });
    // Register the exit hook BEFORE start so a crash during use is caught; a
    // pre-ready exit is surfaced through start()'s rejection (guarded below to
    // avoid double-counting).
    client.onExit(() => this.#onExit(entry, client));
    // Publish the in-flight client synchronously so a dispose() racing the
    // handshake can kill it (its start() may never resolve).
    entry.startingClient = client;
    entry.starting = (async () => {
      try {
        await client.start();
        if (this.#disposed) {
          client.dispose();
          return undefined;
        }
        entry.client = client;
        // A clean init does NOT clear the crash budget — only a completed
        // diagnose (a proven round-trip) does. Resetting here would let a
        // server that crashes on every use reset its budget each respawn and
        // churn forever, never reaching the give-up bound.
        this.#armIdle(entry);
        return client;
      } catch (err) {
        this.#recordCrash(entry, err as Error);
        return undefined;
      } finally {
        entry.startingClient = undefined;
        entry.starting = undefined;
      }
    })();
    return entry.starting;
  }

  #onExit(entry: LangEntry, client: ManagedClient): void {
    // Intentional teardown (idle/dispose) — not a crash.
    if (client === entry.stoppingClient) {
      entry.stoppingClient = undefined;
      return;
    }
    // Only a live, ready client's death counts here; a pre-ready exit rides
    // start()'s rejection instead.
    if (client !== entry.client) return;
    entry.client = undefined;
    this.#clearIdle(entry);
    this.#recordCrash(entry, new Error("language server exited"));
  }

  #recordCrash(entry: LangEntry, err: Error): void {
    entry.restarts++;
    entry.nextRetryAt = this.#now() + Math.min(this.#backoffMs * 2 ** (entry.restarts - 1), MAX_RESTART_BACKOFF_MS);
    if (entry.restarts >= this.#maxRestarts) {
      entry.gaveUp = true;
      this.#log?.debug(`LSP ${entry.language} gave up after ${entry.restarts} restarts: ${err.message}`);
    } else {
      this.#log?.debug(`LSP ${entry.language} crashed (restart ${entry.restarts}/${this.#maxRestarts}): ${err.message}`);
    }
  }

  #armIdle(entry: LangEntry): void {
    if (this.#idleShutdownMs <= 0) return;
    this.#clearIdle(entry);
    const timer = setTimeout(() => this.#idleKill(entry), this.#idleShutdownMs);
    (timer as { unref?: () => void }).unref?.();
    entry.idleTimer = timer;
  }

  #clearIdle(entry: LangEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  #idleKill(entry: LangEntry): void {
    const client = entry.client;
    if (!client) return;
    entry.stoppingClient = client; // its exit is intentional, not a crash
    entry.client = undefined;
    entry.restarts = 0; // idle shutdown isn't a failure — reset the crash budget
    client.dispose();
  }

  #delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      (timer as { unref?: () => void }).unref?.();
    });
  }
}
