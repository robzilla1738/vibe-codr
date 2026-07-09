/**
 * Worker-host `EngineClient` — runs the `Engine` in a `worker_threads` Worker
 * so the engine can never starve the main thread's render/stdin loop (the
 * "freeze" class). The main thread sees the same `EngineClient` shape the
 * in-process `Engine` exposes: a consumed `for await (const event of
 * client.events()) { … }` plus the request/reply methods
 * (`send`/`snapshot`/`listModels`/`listProviders`/`listAgents`/`listSkills`/
 * `finalize`).
 *
 * Why this exists: `AsyncQueue`'s async iterator drains its buffer with
 * synchronous microtask yields (`packages/shared/src/async-queue.ts`), so an
 * in-process engine burst drives the TUI's `for await` as a microtask run,
 * pre-empting paint/stdin until the buffer empties (the freeze). `postMessage`
 * landings are MACROTASKS — the renderer + stdin pump get the loop back
 * between every event, so an engine burst can never again stall the UI.
 *
 * Cross-boundary protocol (see `engine-worker-entry.ts`):
 *
 *   UI → core : `EngineCommand` (forwarded verbatim to `engine.send`)
 *   UI → core : `{ __req, op }` RPC envelope
 *   core → UI : `UIEvent` (forwarded verbatim to the `events()` AsyncQueue)
 *   core → UI : `{ __resp, ok, value }` | `{ __resp, ok:false, error }`
 *   core → UI : `{ __fatal__: true, message }` — engine crashed in the
 *               worker; the main thread must restore the terminal, write the
 *               crash log, and exit. Workers can't `process.exit` the parent
 *               nor restore its raw-mode stdin, so the host MUST own fatal
 *               handling (mirrors `crash.ts`'s `installCrashHandlers`).
 *
 * Every `UIEvent` and `EngineCommand` payload is structured-cloneable (plain
 * objects + `Uint8Array` for image parts), so the bridge is a pure
 * passthrough with no marshalling.
 */
import type { Worker as WorkerType } from "node:worker_threads";
import { AsyncQueue, type EngineClient, type EngineCommand, type EngineSnapshot, type ModelSummary, type AgentInfo, type ProviderInfo, type SkillInfo, type UIEvent } from "@vibe/shared";

/** Wire messages (UI → core). Commands are forwarded raw; RPC calls carry
 * their own envelope so the worker can correlate the reply. */
type Outbound = EngineCommand | { __req: number; op: RpcOp };
type RpcOp = "snapshot" | "listModels" | "listProviders" | "listAgents" | "listSkills" | "finalize";

/** Wire messages (core → UI). */
type Inbound =
  | UIEvent
  | { __resp: number; ok: true; value: unknown }
  | { __resp: number; ok: false; error: string }
  | { __fatal__: true; message: string };

const hasKey = (m: unknown, k: string): m is Record<string, unknown> =>
  m !== null && typeof m === "object" && k in (m as Record<string, unknown>);
const isResp = (m: Inbound): m is Extract<Inbound, { __resp: number }> => hasKey(m, "__resp");
const isFatal = (m: Inbound): m is Extract<Inbound, { __fatal__: true }> => hasKey(m, "__fatal__");
const isInboundEvent = (m: Inbound): m is UIEvent =>
  !isResp(m) && !isFatal(m) && hasKey(m, "type");

export interface WorkerEngineOptions {
  /** Absolute path to the worker entry script. In source: the in-repo
   * `engine-worker-entry.ts`; in the compiled binary: the sibling
   * `vibecodr-engine-worker` emitted by `build:binary`'s second compile
   * target. The CLI resolves both. */
  workerPath: string;
  /** Forwarded to the entry script as `workerData`: the constructor args the
   * in-process CLI used to pass directly to `new Engine({...})`. All
   * structured-cloneable. */
  workerData: {
    config: unknown;
    cwd: string;
    interactive: boolean;
    projectMemory?: string;
    resume?: unknown;
    modelOverride?: string;
    modeOverride?: string;
  };
  /** Fatal handler — owns terminal restore + crash-log + `process.exit(1)`.
   * The host calls this when the worker reports `__fatal__` OR exits with a
   * non-zero code abnormally. Mirrors in-process `crash.ts`. */
  onFatal?: (message: string) => void;
  /** Environment forwarded into the worker as `workerData.env`. Workers
   * inherit a fresh `process.env` at spawn time; XDG/runtime token-file
   * overrides the parent reads LIVE today must be forwarded explicitly.
   * Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Set false to skip mirroring the worker's stderr into the parent's
   * (tests want isolation). Defaults to true in production so engine logs
   * surface in the user's terminal. */
  inheritStderr?: boolean;
}

/**
 * An `EngineClient` whose backing `Engine` runs in a `worker_threads`
 * Worker. Constructed by `packages/cli/src/index.ts` ONLY for the interactive
 * TUI path — the headless `-p` path keeps the in-process `Engine`
 * (single-shot, throughput-sensitive, no freeze concern).
 *
 * Construct via `createWorkerEngineClient` (it resolves `node:worker_threads`
 * dynamically so the npm-in-process bundle doesn't statically pull a Worker
 * import into bundles that never spawn one — the optional-peer invariant).
 */
export class WorkerEngineClient implements EngineClient {
  readonly #worker: WorkerType;
  readonly #events = new AsyncQueue<UIEvent>();
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextReq = 1;
  #closed = false;
  #onFatal?: (message: string) => void;
  #snapshotCache: EngineSnapshot | undefined;
  /** True while a snapshot RPC is in flight (dedupes concurrent cache misses). */
  #snapshotPending = false;
  /** Resolves once the first real snapshot is cached (BUG-084). */
  #ready: Promise<void>;
  #resolveReady!: () => void;
  #readySettled = false;

  /** Internal — use `createWorkerEngineClient` (resolves `Worker` ctor lazily). */
  constructor(worker: WorkerType, opts: WorkerEngineOptions) {
    this.#worker = worker;
    this.#onFatal = opts.onFatal;
    this.#ready = new Promise<void>((r) => {
      this.#resolveReady = r;
    });
    worker.on("message", (msg: Inbound) => this.#onMessage(msg));
    worker.on("error", (err: Error) => this.#onWorkerError(err));
    worker.on("exit", (code: number) => this.#onWorkerExit(code));
    // Tail the worker's stderr into the parent's so engine logs surface. Tests
    // set `inheritStderr:false` to keep worker stderr out of the captured stream.
    if (opts.inheritStderr !== false) {
      worker.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    }
  }

  /** Resolve ready() exactly once (snapshot land OR soft deadline). */
  #settleReady(): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#resolveReady();
  }

  /**
   * Await until the first real engine snapshot is cached. The CLI must call
   * this before `startTui` so `App` seeds model/approvalMode/theme from truth
   * (BUG-084) — not from PLACEHOLDER_SNAPSHOT.
   */
  ready(): Promise<void> {
    return this.#ready;
  }

  /**
   * Kick the initial snapshot RPC. Called once from `createWorkerEngineClient`.
   *
   * Unlike a Promise.race that could open the TUI at 15s with PLACEHOLDER while
   * bootstrap was still running (BUG-107), we wait for the snapshot RPC itself
   * to settle — the worker queues RPCs until after bootstrap, so a late reply
   * is the real engine state. A 15s soft deadline only covers a wedged worker
   * (or a test stub that never answers); session-start still re-seeds App chrome.
   */
  beginHydrate(): void {
    void this.#fetchSnapshot()
      .catch(() => undefined)
      .finally(() => this.#settleReady());
    const soft = setTimeout(() => this.#settleReady(), 15_000);
    (soft as { unref?: () => void }).unref?.();
  }

  /** Fire a snapshot RPC and refresh `#snapshotCache` (shared by hydrate + miss). */
  #fetchSnapshot(): Promise<EngineSnapshot | undefined> {
    if (this.#closed) return Promise.resolve(undefined);
    this.#snapshotPending = true;
    return this.#rpc<EngineSnapshot>("snapshot")
      .then((s) => {
        this.#snapshotCache = s;
        return s;
      })
      .catch(() => undefined)
      .finally(() => {
        this.#snapshotPending = false;
      });
  }

  /** Main message router — events → `events()` queue, RPC replies →
   *  waiters, fatal → caller. */
  #onMessage(msg: Inbound): void {
    if (isFatal(msg)) {
      const cb = this.#onFatal;
      this.#close("fatal");
      cb?.(msg.message);
      return;
    }
    if (isResp(msg)) {
      const waiter = this.#pending.get(msg.__resp);
      if (!waiter) return;
      this.#pending.delete(msg.__resp);
      if (msg.ok) waiter.resolve(msg.value);
      else waiter.reject(new Error(msg.error));
      return;
    }
    if (isInboundEvent(msg)) {
      // Live state changed — refresh the snapshot cache via re-RPC so
      // refreshStatus() still sees real commandNames/busy (not PLACEHOLDER).
      // Keep the last-good cache until the new RPC lands so we never wipe the
      // slash cue mid-event. Mode/model chips also ride the events themselves.
      if (
        msg.type === "mode-changed" ||
        msg.type === "approvals-changed" ||
        msg.type === "model-changed" ||
        msg.type === "goal-changed" ||
        msg.type === "session-start"
      ) {
        if (!this.#snapshotPending) {
          void this.#fetchSnapshot().then((s) => {
            // Bootstrap finished after ready()'s soft deadline — mark ready and
            // land the real snapshot so App can re-seed chrome (BUG-107).
            if (s?.model) this.#settleReady();
          });
        }
        // session-start always carries model/mode — unblock ready immediately
        // even if the snapshot RPC is still queued behind bootstrap.
        if (msg.type === "session-start") this.#settleReady();
      }
      this.#events.push(msg);
    }
  }

  #onWorkerError(err: Error): void {
    if (this.#closed) return;
    this.#fatal(err.message);
  }

  #onWorkerExit(code: number): void {
    if (this.#closed) return;
    if (code === 0) {
      this.#close("graceful");
      return;
    }
    this.#fatal(`engine worker exited unexpectedly with code ${code}`);
  }

  /** Hand the fatal surface back to the host, then close. */
  #fatal(message: string): void {
    const cb = this.#onFatal;
    this.#close("fatal");
    cb?.(message);
  }

  /** Reject every pending RPC + close the event stream. Idempotent. */
  #close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#pending.values()) waiter.reject(new Error(`engine worker closed (${reason})`));
    this.#pending.clear();
    this.#events.close();
  }

  events(): AsyncIterable<UIEvent> {
    return this.#events;
  }

  send(command: EngineCommand): void {
    if (this.#closed) return;
    this.#worker.postMessage(command);
  }

  snapshot(): EngineSnapshot {
    // Prefer the cached snapshot (kept warm across mode/model/goal events via
    // re-RPC in #onMessage). Cache miss (pre-hydrate or after a failed RPC):
    // fire a fetch so the next call is real — never permanently stuck on
    // PLACEHOLDER after a state change (BUG-084 regression).
    if (!this.#snapshotCache && !this.#closed && !this.#snapshotPending) {
      void this.#fetchSnapshot();
    }
    return this.#snapshotCache ?? PLACEHOLDER_SNAPSHOT;
  }

  listModels = (): Promise<ModelSummary[]> => this.#rpc("listModels");
  listProviders = (): Promise<ProviderInfo[]> => this.#rpc("listProviders");
  listAgents = (): Promise<AgentInfo[]> => this.#rpc("listAgents");
  listSkills = (): Promise<SkillInfo[]> => this.#rpc("listSkills");

  finalize = async (): Promise<void> => {
    if (this.#closed) return;
    try {
      // Bound the finalize handshake so a wedged in-worker teardown (a
      // stuck MCP server, an unyielding child process) can't trap the CLI
      // on /exit. Mirrors `engine.finalize()`'s own 5s `awaitAllDetached`
      // cap (per CHANGELOG 8fff1e5). The worker is force-terminated
      // after the bound — same outcome, no leak.
      await Promise.race([
        this.#rpc<void>("finalize"),
        new Promise<void>((r) => setTimeout(r, 5_000)),
      ]);
    } catch {
      // Worker already exited (e.g. a fatal ran onFatal then the host
      // awaited finalize); treat as best-effort teardown.
    }
    this.#close("finalize");
    try {
      this.#worker.terminate();
    } catch {
      // already gone — fine
    }
  };

  /** Issue an RPC to the worker and await its envelope reply. */
  readonly #rpc = <T>(op: RpcOp): Promise<T> => {
    if (this.#closed) return Promise.reject(new Error("engine worker closed"));
    const id = this.#nextReq++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (v: unknown) => resolve(v as T), reject });
      this.#worker.postMessage({ __req: id, op } satisfies Outbound);
    });
  };
}

/**
 * Construct a `WorkerEngineClient`. Async because resolving the
 * `node:worker_threads` Worker ctor is a dynamic import — kept non-literal
 * so the npm-in-process bundle (which never spawns a worker; the `-p` path
 * stays in-process in source anyway) doesn't statically pull worker_threads
 * into bundles that disable the worker. Optional-peer invariant preserved.
 */
export async function createWorkerEngineClient(opts: WorkerEngineOptions): Promise<WorkerEngineClient> {
  const mod = "node:worker_threads";
  const { Worker } = await import(mod);
  const worker = new Worker(opts.workerPath, {
    type: "module",
    workerData: { ...(opts.workerData ?? {}), env: opts.env ?? { ...process.env } },
  });
  const client = new WorkerEngineClient(worker, opts);
  // BUG-084: block until the first real snapshot is cached so startTui /
  // App seed model + approvalMode + theme from the engine, not the placeholder.
  client.beginHydrate();
  await client.ready();
  return client;
}

/**
 * Type-correct empty snapshot used only before `ready()` resolves (or if
 * hydrate fails). Production CLI always awaits ready before startTui.
 */
const PLACEHOLDER_SNAPSHOT: EngineSnapshot = {
  sessionId: "",
  model: "",
  mode: "execute",
  approvalMode: "ask",
  goal: null,
  history: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
  tasks: [],
  busy: false,
  theme: "default",
  accentColor: "",
  details: "normal",
      mouse: true,
  commandNames: [],
};

