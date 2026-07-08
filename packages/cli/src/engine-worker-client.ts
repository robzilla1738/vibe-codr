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
  #snapshotPending = false;

  /** Internal — use `createWorkerEngineClient` (resolves `Worker` ctor lazily). */
  constructor(worker: WorkerType, opts: WorkerEngineOptions) {
    this.#worker = worker;
    this.#onFatal = opts.onFatal;
    worker.on("message", (msg: Inbound) => this.#onMessage(msg));
    worker.on("error", (err: Error) => this.#onWorkerError(err));
    worker.on("exit", (code: number) => this.#onWorkerExit(code));
    // Tail the worker's stderr into the parent's so engine logs surface. Tests
    // set `inheritStderr:false` to keep worker stderr out of the captured stream.
    if (opts.inheritStderr !== false) {
      worker.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    }
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
      // Invalidate the one-shot snapshot cache when live state changes so a
      // later snapshot() re-RPCs (commandNames, approvalMode, etc. stay fresh).
      // Mode/model/goal for the chip already ride events; this is for anything
      // that still reads snapshot().
      if (
        msg.type === "mode-changed" ||
        msg.type === "approvals-changed" ||
        msg.type === "model-changed" ||
        msg.type === "goal-changed" ||
        msg.type === "session-start"
      ) {
        this.#snapshotCache = undefined;
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
    // First-paint call. The worker hasn't necessarily replied yet, so fire
    // the RPC and cache the result for the NEXT call. The live stream's
    // `session-start`/`model-changed`/`mode-changed`/`goal-changed`/
    // `git-updated`/`usage-updated` events fire at bootstrap before the UI
    // is fully mounted (the AsyncQueue buffers pre-subscriber events), so
    // the footer/icon populate from the stream even without the snapshot.
    // The placeholder is type-correct so first paint renders cleanly.
    //
    // The RPC is fired AT MOST ONCE: `#snapshotPending` guards against
    // duplicate-snapshot RPCs from a host that polls `snapshot()` any
    // number of times before the worker replies (the TUI's mountApp polls
    // exactly once, but the type contract allows arbitrary polling, and a
    // duplicate RPC would waste a round-trip per poll).
    if (this.#snapshotCache) return this.#snapshotCache;
    if (this.#snapshotPending) return PLACEHOLDER_SNAPSHOT;
    this.#snapshotPending = true;
    void this.#rpc<EngineSnapshot>("snapshot")
      .then((s) => {
        this.#snapshotCache = s;
      })
      .catch(() => {
        // Worker died / tearing down — events stream carries the same fields.
      })
      .finally(() => {
        this.#snapshotPending = false;
      });
    return PLACEHOLDER_SNAPSHOT;
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
  return new WorkerEngineClient(worker, opts);
}

/**
 * The minimal `EngineSnapshot` returned before the worker has replied. The
 * interactive TUI populates model/mode/goal/git/usage from `session-start` +
 * `model-changed` + `mode-changed` + `goal-changed` + `git-updated` +
 * `usage-updated` events that fire on bootstrap (the AsyncQueue buffers them
 * pre-subscriber, so they arrive before the TUI is fully mounted). The
 * placeholder only frames the very first paint — and every field is
 * type-correct (matches `EngineSnapshot`) so the theme/mode-chip render runs
 * without throwing.
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
  commandNames: [],
};

