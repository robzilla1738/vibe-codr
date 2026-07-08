import { pathToFileURL } from "node:url";
import { killTree } from "@vibe/tools";
import type { Logger } from "@vibe/shared";

/**
 * One spawned language server, driven over stdio with LSP's Content-Length
 * JSON-RPC framing. Minimal by design: `initialize`→`initialized`, then
 * `didOpen`/`didChange` per file and version-matched `publishDiagnostics`
 * collection. Every failure path (dead pipe, protocol error, deadline) resolves
 * to undefined — diagnostics are advisory, never a false "clean". The process is
 * spawned via an injectable factory so tests can use a real stdio mock server (or
 * a fake), and torn down with `killTree` so no server grandchild is orphaned.
 */

/** The subset of a spawned process the client drives. */
export interface LspProcess {
  /** Bun FileSink (or a stub): accepts a byte chunk, optional explicit flush. */
  stdin: { write(chunk: Uint8Array): unknown; flush?(): void; end?(): void };
  stdout: ReadableStream<Uint8Array>;
  pid: number;
  kill(): void;
  exited: Promise<number>;
}

/** Spawn a server process for `command`/`args` in `cwd`. Injectable for tests. */
export type SpawnLsp = (command: string, args: string[], cwd: string) => LspProcess;

/** Default transport: a real Bun child over stdio, reaped as a tree on teardown
 * (a language server can fork workers — `proc.kill()` alone would orphan them). */
export const defaultLspSpawn: SpawnLsp = (command, args, cwd) => {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    // A server's stderr is diagnostic noise (progress, logs) — never framed
    // JSON-RPC — so drop it rather than interleave it with the protocol stream.
    stderr: "ignore",
  });
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    pid: proc.pid,
    kill: () => killTree(proc.pid),
    exited: proc.exited,
  };
};

export interface LspClientOptions {
  command: string;
  args: string[];
  /** Workspace root — becomes the server's rootUri/workspaceFolder. */
  rootPath: string;
  /** LSP languageId sent in didOpen (e.g. "python", "rust"). */
  languageId: string;
  /** First-spawn handshake deadline (ms) — decoupled from the per-diagnose one. */
  initializeTimeoutMs: number;
  spawn: SpawnLsp;
  log?: Logger;
}

/** LSP severities we surface: 1=Error, 2=Warning. Hints/info are noise in-loop. */
const RENDERED_SEVERITY = new Set([1, 2]);
/** Cap rendered diagnostics — the first errors are the signal (parity with TS). */
const MAX_DIAGNOSTICS = 8;
const SEVERITY_LABEL: Record<number, string> = { 1: "error", 2: "warning" };

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}
interface PublishParams {
  uri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
}

/** A message either resolves an in-flight request (has `id`) or is a
 * server→client notification (`method`, no response). */
interface RpcMessage {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  params?: unknown;
}

const CRLFCRLF = Uint8Array.of(13, 10, 13, 10);

export class LspClient {
  #opts: LspClientOptions;
  #proc: LspProcess | undefined;
  #buffer = new Uint8Array(0);
  #nextId = 1;
  #pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Monotonic per-uri document version (didOpen=1, then didChange bumps). */
  #versions = new Map<string, number>();
  /** Whether the uri has been didOpen'd (didChange requires a prior didOpen). */
  #opened = new Set<string>();
  /** The in-flight diagnose waiter for a uri, keyed by uri. */
  #waiters = new Map<string, { version: number; resolve: (d: LspDiagnostic[] | undefined) => void }>();
  #exited = false;
  #exitCbs: ((code: number) => void)[] = [];
  #encoder = new TextEncoder();

  constructor(opts: LspClientOptions) {
    this.#opts = opts;
  }

  /** Register a one-shot-ish exit callback (fires once when the process dies). */
  onExit(cb: (code: number) => void): void {
    this.#exitCbs.push(cb);
  }

  /** Spawn + handshake, bounded by the initialize deadline. Rejects (and tears
   * down the process) on a failed/timed-out handshake so the manager counts it as
   * a crash rather than leaking a half-initialized server. */
  async start(): Promise<void> {
    const proc = this.#opts.spawn(this.#opts.command, this.#opts.args, this.#opts.rootPath);
    this.#proc = proc;
    void proc.exited.then(
      (code) => this.#handleExit(code),
      () => this.#handleExit(-1),
    );
    void this.#readLoop();
    try {
      const rootUri = pathToFileURL(this.#opts.rootPath).href;
      await this.#request(
        "initialize",
        {
          processId: process.pid,
          rootUri,
          rootPath: this.#opts.rootPath,
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: false },
              publishDiagnostics: { relatedInformation: false },
            },
            workspace: { workspaceFolders: true },
          },
          workspaceFolders: [{ uri: rootUri, name: "root" }],
        },
        this.#opts.initializeTimeoutMs,
      );
      this.#notify("initialized", {});
    } catch (err) {
      this.dispose();
      throw err;
    }
  }

  /**
   * Diagnose one file: read its current bytes from disk, didOpen (first time) or
   * didChange (bump the version), then wait up to `timeoutMs` for a
   * version-matched `publishDiagnostics`. Returns a rendered error list, or
   * undefined when clean / unreadable / the deadline hits (advisory).
   */
  async diagnose(absPath: string, timeoutMs: number): Promise<string | undefined> {
    if (this.#exited || !this.#proc) return undefined;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(await Bun.file(absPath).arrayBuffer());
    } catch {
      return undefined; // unreadable/deleted between the edit and here — skip.
    }
    const uri = pathToFileURL(absPath).href;
    const version = (this.#versions.get(uri) ?? 0) + 1;
    this.#versions.set(uri, version);

    // Resolve any prior waiter for this uri (a re-diagnose supersedes it).
    this.#waiters.get(uri)?.resolve(undefined);

    const wait = new Promise<LspDiagnostic[] | undefined>((resolve) => {
      this.#waiters.set(uri, { version, resolve });
    });

    try {
      if (this.#opened.has(uri)) {
        this.#notify("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
      } else {
        this.#opened.add(uri);
        this.#notify("textDocument/didOpen", {
          textDocument: { uri, languageId: this.#opts.languageId, version, text },
        });
      }
    } catch {
      this.#waiters.delete(uri);
      return undefined; // write to a dead pipe — advisory skip.
    }

    const timer = setTimeout(() => {
      const w = this.#waiters.get(uri);
      if (w && w.version === version) {
        this.#waiters.delete(uri);
        w.resolve(undefined);
      }
    }, timeoutMs);
    // The idle/diagnose deadline timer must never keep the process alive on its own.
    (timer as { unref?: () => void }).unref?.();

    const diags = await wait;
    clearTimeout(timer);
    if (!diags) return undefined;
    return this.#render(absPath, diags);
  }

  /** Kill the process tree (idempotent). */
  dispose(): void {
    if (!this.#proc) return;
    // BUG-065: settle pending + flip exited BEFORE kill so concurrent
    // diagnose() fails closed instead of writing to a dead stdin.
    this.#handleExit(-1);
    try {
      this.#proc.stdin.end?.();
    } catch {
      /* pipe may already be closed */
    }
    try {
      this.#proc.kill();
    } catch {
      /* already gone */
    }
  }

  // --- internals -----------------------------------------------------------

  #render(absPath: string, diags: LspDiagnostic[]): string | undefined {
    const relevant = diags.filter((d) => RENDERED_SEVERITY.has(d.severity ?? 1));
    if (!relevant.length) return undefined;
    const lines = relevant.slice(0, MAX_DIAGNOSTICS).map((d) => {
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const sev = SEVERITY_LABEL[d.severity ?? 1] ?? "error";
      const code = d.code !== undefined && d.code !== "" ? ` [${d.source ? `${d.source} ` : ""}${d.code}]` : d.source ? ` [${d.source}]` : "";
      return `  ${absPath}:${line}:${col} ${sev}${code}: ${d.message.replace(/\s+/g, " ").trim()}`;
    });
    const more = relevant.length > MAX_DIAGNOSTICS ? `\n  …(${relevant.length - MAX_DIAGNOSTICS} more)` : "";
    return `LSP diagnostics (${this.#opts.languageId}) — fix before moving on:\n${lines.join("\n")}${more}`;
  }

  #handleExit(code: number): void {
    if (this.#exited) return;
    this.#exited = true;
    // Fail every in-flight request + diagnose waiter so nothing hangs.
    for (const p of this.#pending.values()) p.reject(new Error("language server exited"));
    this.#pending.clear();
    for (const w of this.#waiters.values()) w.resolve(undefined);
    this.#waiters.clear();
    for (const cb of this.#exitCbs) {
      try {
        cb(code);
      } catch {
        /* a callback must not break teardown */
      }
    }
  }

  #request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.#nextId++;
    const p = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return withTimeout(p, timeoutMs, `${method} on ${this.#opts.command}`).catch((err) => {
      this.#pending.delete(id);
      throw err;
    });
  }

  #notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #send(msg: unknown): void {
    if (!this.#proc) throw new Error("no process");
    const body = this.#encoder.encode(JSON.stringify(msg));
    const header = this.#encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
    const frame = new Uint8Array(header.length + body.length);
    frame.set(header, 0);
    frame.set(body, header.length);
    this.#proc.stdin.write(frame);
    this.#proc.stdin.flush?.();
  }

  async #readLoop(): Promise<void> {
    if (!this.#proc) return;
    const reader = this.#proc.stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) this.#onData(value);
      }
    } catch {
      /* stream error — exit handling below */
    } finally {
      reader.releaseLock?.();
      this.#handleExit(-1);
    }
  }

  #onData(chunk: Uint8Array): void {
    // Append to the byte buffer (Content-Length is in BYTES, so we frame on
    // bytes, never on a decoded string — multibyte chars would misalign it).
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer, 0);
    merged.set(chunk, this.#buffer.length);
    this.#buffer = merged;

    for (;;) {
      const headerEnd = indexOfSub(this.#buffer, CRLFCRLF);
      if (headerEnd < 0) return;
      const header = asciiDecode(this.#buffer.subarray(0, headerEnd));
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Malformed header block — drop it and resync past the terminator.
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + len) return; // body not fully arrived
      const body = this.#buffer.subarray(bodyStart, bodyStart + len);
      this.#buffer = this.#buffer.subarray(bodyStart + len);
      let msg: RpcMessage;
      try {
        msg = JSON.parse(new TextDecoder("utf-8").decode(body)) as RpcMessage;
      } catch {
        continue; // skip an unparseable frame
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg: RpcMessage): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "LSP request failed"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as PublishParams | undefined;
      if (!params?.uri) return;
      const w = this.#waiters.get(params.uri);
      // Accept when the version matches what we just sent, or the server omitted
      // a version (optional in the spec — many servers don't echo it).
      if (w && (params.version === undefined || params.version === w.version)) {
        this.#waiters.delete(params.uri);
        w.resolve(params.diagnostics ?? []);
      }
      return;
    }
    // BUG-062: reply to server *requests* so strict LSPs (jdtls, etc.) don't
    // hang waiting for client/registerCapability / workspace/configuration.
    if (msg.id !== undefined && msg.method) {
      const result =
        msg.method === "workspace/configuration"
          ? []
          : msg.method === "client/registerCapability" ||
              msg.method === "client/unregisterCapability" ||
              msg.method === "window/workDoneProgress/create"
            ? null
            : {};
      try {
        this.#send({ jsonrpc: "2.0", id: msg.id, result });
      } catch {
        /* process may be dying */
      }
    }
  }
}

/** Reject if `p` doesn't settle within `ms` (the mcp.ts pattern). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms ${what}`)), ms);
    (timer as { unref?: () => void }).unref?.();
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

/** Index of the first occurrence of `sub` in `buf`, or -1. */
function indexOfSub(buf: Uint8Array, sub: Uint8Array): number {
  outer: for (let i = 0; i + sub.length <= buf.length; i++) {
    for (let j = 0; j < sub.length; j++) {
      if (buf[i + j] !== sub[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Decode an ASCII header slice (headers are always ASCII per the LSP spec). */
function asciiDecode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}
