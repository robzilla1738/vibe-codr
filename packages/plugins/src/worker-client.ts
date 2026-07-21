import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookName } from "./hooks.ts";
import type { SlashResult } from "./commands.ts";
import {
  PLUGIN_WORKER_LIMITS,
  encodedJsonBytes,
  isJsonValue,
  parsePluginWorkerStartResult,
  parseWorkerResponse,
  type IsolatedPluginMetadata,
  type JsonValue,
  type PluginWorkerErrorCode,
  type PluginWorkerRequest,
  type PluginWorkerRequestBody,
  type PluginWorkerStartResult,
} from "./worker-protocol.ts";

export interface PluginWorkerOptions {
  specifier: string;
  cwd: string;
  workerPath?: string;
  startupTimeoutMs?: number;
  rpcTimeoutMs?: number;
}

export interface StartedPluginWorker {
  client: PluginWorkerClient;
  result: PluginWorkerStartResult;
}

export class PluginWorkerError extends Error {
  readonly code: PluginWorkerErrorCode;
  constructor(code: PluginWorkerErrorCode) {
    super(`isolated plugin worker ${code}`);
    this.name = "PluginWorkerError";
    this.code = code;
  }
}

interface Pending {
  resolve(value: JsonValue): void;
  reject(error: PluginWorkerError): void;
  timer: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
}

export class PluginWorkerClient {
  metadata: IsolatedPluginMetadata | null;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #rpcTimeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #requestCount = 0;
  #closed = false;
  #stdout = Buffer.alloc(0);
  #stderrBytes = 0;

  private constructor(child: ChildProcessWithoutNullStreams, rpcTimeoutMs: number) {
    this.#child = child;
    this.#rpcTimeoutMs = rpcTimeoutMs;
    this.metadata = null;
    child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
      if (this.#stderrBytes > PLUGIN_WORKER_LIMITS.outputBytes) this.#terminate("output-too-large");
    });
    child.on("error", () => this.#terminate("crashed"));
    child.on("exit", (code) => {
      if (!this.#closed) this.#terminate(code === 0 ? "closed" : "crashed");
    });
  }

  static async start(options: PluginWorkerOptions): Promise<StartedPluginWorker> {
    const child = spawn(process.execPath, [options.workerPath ?? resolvePluginWorkerPath()], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: safeWorkerEnvironment(),
      windowsHide: true,
    });
    const client = new PluginWorkerClient(child, options.rpcTimeoutMs ?? PLUGIN_WORKER_LIMITS.rpcMs);
    try {
      const rawResult = await client.#rpc(
        { op: "init", specifier: options.specifier },
        undefined,
        options.startupTimeoutMs ?? PLUGIN_WORKER_LIMITS.startupMs,
      );
      const result = parsePluginWorkerStartResult(rawResult);
      if (!result) {
        client.#terminate("invalid-frame");
        throw new PluginWorkerError("invalid-frame");
      }
      if (result.status === "ready") client.metadata = result.metadata;
      else await client.close();
      return { client, result };
    } catch (error) {
      client.#terminate(error instanceof PluginWorkerError ? error.code : "plugin-load-failed");
      throw error;
    }
  }

  callTool(name: string, input: JsonValue, context: Record<string, JsonValue> = {}, signal?: AbortSignal): Promise<JsonValue> {
    return this.#rpc({ op: "tool", name, input, context }, signal);
  }

  runCommand(name: string, args: string, signal?: AbortSignal): Promise<SlashResult> {
    return this.#rpc({ op: "command", name, args }, signal) as Promise<SlashResult>;
  }

  runHook(name: HookName, payload: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
    return this.#rpc({ op: "hook", name, payload }, signal);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try { await this.#rpc({ op: "shutdown" }, undefined, 1_000); }
    catch { /* shutdown is best effort */ }
    this.#terminate("closed");
  }

  #rpc(
    body: PluginWorkerRequestBody,
    signal?: AbortSignal,
    timeoutMs = this.#rpcTimeoutMs,
  ): Promise<JsonValue> {
    if (this.#closed) return Promise.reject(new PluginWorkerError("closed"));
    if (signal?.aborted) {
      this.#terminate("aborted");
      return Promise.reject(new PluginWorkerError("aborted"));
    }
    if (this.#pending.size >= PLUGIN_WORKER_LIMITS.maxPending || ++this.#requestCount > PLUGIN_WORKER_LIMITS.maxRequests) {
      this.#terminate("request-limit");
      return Promise.reject(new PluginWorkerError("request-limit"));
    }
    const id = this.#nextId++;
    const request = { v: 1, id, ...body } as PluginWorkerRequest;
    if (!isJsonValue(request) || encodedJsonBytes(request) > PLUGIN_WORKER_LIMITS.frameBytes) {
      return Promise.reject(new PluginWorkerError("invalid-frame"));
    }
    return new Promise<JsonValue>((resolve, reject) => {
      const abort = signal ? () => this.#terminate("aborted") : undefined;
      const timer = setTimeout(() => this.#terminate("timeout"), timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        ...(signal && abort ? { removeAbort: () => signal.removeEventListener("abort", abort) } : {}),
      });
      signal?.addEventListener("abort", abort!, { once: true });
      this.#child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) this.#terminate("crashed");
      });
    });
  }

  #onStdout(chunk: Buffer): void {
    if (this.#closed) return;
    this.#stdout = Buffer.concat([this.#stdout, chunk]);
    if (this.#stdout.byteLength > PLUGIN_WORKER_LIMITS.frameBytes && !this.#stdout.includes(10)) {
      this.#terminate("invalid-frame");
      return;
    }
    while (true) {
      const newline = this.#stdout.indexOf(10);
      if (newline < 0) return;
      const frame = this.#stdout.subarray(0, newline);
      this.#stdout = this.#stdout.subarray(newline + 1);
      if (frame.byteLength === 0) continue;
      if (frame.byteLength > PLUGIN_WORKER_LIMITS.frameBytes) {
        this.#terminate("invalid-frame");
        return;
      }
      let decoded: unknown;
      try { decoded = JSON.parse(frame.toString("utf8")); }
      catch {
        this.#terminate("invalid-frame");
        return;
      }
      const response = parseWorkerResponse(decoded);
      if (!response || encodedJsonBytes(response) > PLUGIN_WORKER_LIMITS.outputBytes) {
        this.#terminate("invalid-frame");
        return;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) {
        this.#terminate("invalid-frame");
        return;
      }
      if (!response.ok && (response.error === "invalid-frame" || response.error === "output-too-large" || response.error === "request-limit")) {
        this.#terminate(response.error);
        return;
      }
      this.#pending.delete(response.id);
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      if (response.ok) pending.resolve(response.value as JsonValue);
      else pending.reject(new PluginWorkerError(response.error));
    }
  }

  #terminate(code: PluginWorkerErrorCode): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(new PluginWorkerError(code));
    }
    this.#pending.clear();
    this.#stdout = Buffer.alloc(0);
    try { this.#child.stdin.destroy(); } catch { /* already closed */ }
    killProcessTree(this.#child);
  }
}

export function resolvePluginWorkerPath(): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  let invokedDir = dirname(process.argv[1] ?? "");
  try { invokedDir = dirname(realpathSync(process.argv[1] ?? "")); } catch { /* source/test invocation */ }
  const candidates = [
    join(dirname(process.execPath), `vibecodr-plugin-worker${suffix}`),
    join(invokedDir, "vibecodr-plugin-worker.js"),
    fileURLToPath(new URL("./worker-entry.ts", import.meta.url)),
  ];
  return candidates.find(existsSync) ?? candidates.at(-1)!;
}

function safeWorkerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}

function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
}
