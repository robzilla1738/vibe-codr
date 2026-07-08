/**
 * Worker entry script for the `WorkerEngineClient` (UI lives on the main
 * thread, `Engine` lives here). It constructs the in-process `Engine`
 * exactly as `packages/cli/src/index.ts` used to, then:
 *
 *   • forwards `parentPort` commands (`EngineCommand`) into `engine.send`
 *   • subscribes once to `engine.events()` and pipes every `UIEvent` out via
 *     `parentPort.postMessage`. Worker→UI messages are MACROTASK landings on
 *     the main thread, so an engine burst can never starve paint/stdin (the
 *     freeze root cause — see `engine-worker-client.ts`).
 *   • answers RPC envelopes (`{ __req, op }`) for snapshot / listModels /
 *     listProviders / listAgents / listSkills / finalize.
 *   • installs an in-worker `uncaughtException`/`unhandledRejection` handler
 *     that posts `{ __fatal__: true, message }` to the host. Workers can't
 *     `process.exit` the parent nor restore its raw-mode stdin, so fatal
 *     handling moves to the host (mirrors `crash.ts`'s `installCrashHandlers`).
 *
 * `bun build --compile` bundles this as a sibling target
 * (`dist/vibecodr-engine-worker`) when building the standalone binary; the
 * main binary spawns it by path. In source/dev runs, the main script spawns
 * `engine-worker-entry.ts` directly via `new Worker(path)`.
 */
import { Engine } from "@vibe/core";
import type { EngineCommand, EngineSnapshot, UIEvent } from "@vibe/shared";

type RpcOp = "snapshot" | "listModels" | "listProviders" | "listAgents" | "listSkills" | "finalize";

interface HostWorkerData {
  config: unknown;
  cwd: string;
  interactive: boolean;
  projectMemory?: string;
  resume?: unknown;
  modelOverride?: string;
  modeOverride?: string;
  env?: Record<string, string | undefined>;
}

interface RpcRequest {
  __req: number;
  op: RpcOp;
}

interface RpcRespOk {
  __resp: number;
  ok: true;
  value: unknown;
}

interface RpcRespErr {
  __resp: number;
  ok: false;
  error: string;
}

type Inbound = EngineCommand | RpcRequest;

const isRpc = (m: unknown): m is RpcRequest =>
  m !== null && typeof m === "object" && "__req" in (m as Record<string, unknown>);

// `parentPort` is set when this file runs inside a worker — defensive in case
// it's ever imported from a non-worker context (tests), where it would be
// null and we'd no-op rather than throw.
const { parentPort, workerData } = await import("node:worker_threads");
if (!parentPort) {
  // Not in a worker — nothing to do. Bail with a recognizable exit so the
  // host's `onExit` handler doesn't mistake this for a crash.
  process.exit(0);
}

const port: NonNullable<typeof parentPort> = parentPort;
const data = workerData as HostWorkerData | undefined;

// Apply the env snapshot the host forwarded. Bun workers inherit the parent's
// env at spawn, but the host explicitly re-forwards `process.env` anyway so a
// runtime XDG / token-file override the parent reads LIVE today is visible
// here too (AGENTS.md: XDG is read live; Bun's `os.homedir()` caches at
// spawn, so the explicit forward is the backstop).
if (data?.env) {
  for (const [k, v] of Object.entries(data.env)) {
    if (v !== undefined) process.env[k] = v;
  }
}

// In-worker fatal handler. A throw here is fatal to the WORKER, not the parent
// process — but Bun workers propagate an unhandled `error` event to the host's
// `Worker.on('error')`, which `WorkerEngineClient` routes to its `onFatal`.
// We also explicitly post a `__fatal__` sentinel so the host knows to restore
// the terminal + write the crash log + exit 1, mirroring `crash.ts`. Both
// paths land on the host's `onFatal`; the explicit sentinel carries the
// message text the host's crash log wants.
let fatalFired = false;
const reportFatal = (message: string): void => {
  if (fatalFired) return;
  fatalFired = true;
  try {
    port.postMessage({ __fatal__: true, message });
  } catch {
    // Worker is being torn down — `on('error')` / `on('exit')` will inform.
  }
};
process.on("uncaughtException", (err: Error) => reportFatal(`engine worker: ${err.message}`));
process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  reportFatal(`engine worker: unhandled rejection — ${message}`);
});

const opts = data as HostWorkerData;
const engine = new Engine({
  config: opts.config as never,
  cwd: opts.cwd,
  interactive: opts.interactive,
  ...(opts.projectMemory ? { projectMemory: opts.projectMemory } : {}),
  ...(opts.resume ? { resume: opts.resume as never } : {}),
  ...(opts.modelOverride ? { modelOverride: opts.modelOverride } : {}),
  ...(opts.modeOverride ? { modeOverride: opts.modeOverride as never } : {}),
});

// Bootstrap the engine (load agents/commands/skills/plugins, MCP connect,
// recon, restore engine state, git emit) before wiring ports — events
// emitted during bootstrap are buffered in the EventBus's per-subscriber
// AsyncQueue, so they're delivered in order to whoever subscribes next.
await engine.bootstrap();

// Subscribe ONCE to the engine's event stream and pipe every event to the
// host. The EventBus hands each subscriber its own lossless, unbounded
// AsyncQueue — same backpressure semantics as a MessagePort. Structured
// clone is the wire format; every UIEvent payload is a plain object (some
// carry `Uint8Array` image parts, which clone cleanly).
void (async () => {
  for await (const event of engine.events() as AsyncIterable<UIEvent>) {
    port.postMessage(event);
  }
  // The event stream ends on `engine.finalize()` (EventBus.close()) — signal
  // end-of-stream to the host so its `events()` queue closes (parity with
  // the in-process `EventBus.close()` behavior the TUI relied on today).
  // We post a sentinel that the host recognizes as "stream-end" by virtue of
  // the worker exiting (the host's `onExit(code=0)` closes the queue).
})();

// Handle inbound commands + RPC from the host.
port.on("message", async (msg: Inbound) => {
  if (isRpc(msg)) {
    try {
      const value = await handleRpc(msg.op);
      const resp: RpcRespOk = { __resp: msg.__req, ok: true, value };
      port.postMessage(resp);
    } catch (err) {
      const resp: RpcRespErr = {
        __resp: msg.__req,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      port.postMessage(resp);
    }
    return;
  }
  // Plain `EngineCommand` — forward verbatim. `engine.send` is sync-safe.
  engine.send(msg);
});

async function handleRpc(op: RpcOp): Promise<unknown> {
  switch (op) {
    case "snapshot":
      return engine.snapshot() as EngineSnapshot;
    case "listModels":
      return engine.listModels();
    case "listProviders":
      return engine.listProviders?.() ?? [];
    case "listAgents":
      return engine.listAgents?.() ?? [];
    case "listSkills":
      return engine.listSkills?.() ?? [];
    case "finalize": {
      await engine.finalize();
      port.unref();
      // Allow the parent to exit; the host calls `worker.terminate()` after
      // finalize resolves regardless. We do NOT exit preemptively — the
      // finalize RPC reply must be flushed first (the host awaits it).
      return undefined;
    }
    default:
      throw new Error(`unknown rpc op: ${op as string}`);
  }
}

// `SIGTERM`/`SIGHUP` reach the worker (one process). Treat as fatal so the
// host crash handler runs (restore terminal + write crash log + exit). A
// SIGINT mid-turn is handled by the host as a steer/abort, not a fatal —
// that path doesn't reach the worker's signal handlers because the host
// forwards `{ type: "abort" }` as an `EngineCommand` instead.
process.on("SIGTERM", () => reportFatal("engine worker: SIGTERM"));
process.on("SIGHUP", () => reportFatal("engine worker: SIGHUP"));