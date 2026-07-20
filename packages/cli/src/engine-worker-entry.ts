/**
 * Worker entry script for the `WorkerEngineClient` (UI lives on the main
 * thread, `Engine` lives here). It opens the in-process RuntimeService
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
import type { UIEvent } from "@vibe/shared";
import { openRuntimeSession } from "@vibe/runtime";
import {
  isEngineWorkerRpcRequest,
  type EngineWorkerData,
  type EngineWorkerInbound,
  type EngineWorkerRpcError,
  type EngineWorkerRpcOp,
  type EngineWorkerRpcResults,
  type EngineWorkerRpcSuccess,
} from "./engine-worker-protocol.ts";

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
const data = workerData as EngineWorkerData | undefined;

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

const opts = data as EngineWorkerData;
const engine = await openRuntimeSession({
  config: opts.config as never,
  cwd: opts.cwd,
  interactive: opts.interactive,
  projectMemory: opts.projectMemory ?? "",
  resume: opts.resume
    ? { kind: "loaded", session: opts.resume as never }
    : { kind: "new" },
  acquireLease: false,
  ...(opts.modelOverride ? { modelOverride: opts.modelOverride } : {}),
  ...(opts.modeOverride ? { modeOverride: opts.modeOverride as never } : {}),
});

// Accept host RPC/commands as soon as the worker starts (host beginHydrate
// races bootstrap). Queue until bootstrap finishes so snapshot includes
// commands/skills/plugins and model resolution is stable (BUG-084).
let bootstrapped = false;
const inboundQueue: EngineWorkerInbound[] = [];

async function handleInbound(msg: EngineWorkerInbound): Promise<void> {
  if (isEngineWorkerRpcRequest(msg)) {
    try {
      const value = await handleRpc(msg.op);
      const resp: EngineWorkerRpcSuccess = { __resp: msg.__req, ok: true, value };
      port.postMessage(resp);
    } catch (err) {
      const resp: EngineWorkerRpcError = {
        __resp: msg.__req,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      port.postMessage(resp);
    }
    return;
  }
  engine.send(msg);
}

port.on("message", (msg: EngineWorkerInbound) => {
  if (!bootstrapped) {
    inboundQueue.push(msg);
    return;
  }
  void handleInbound(msg);
});

// Subscribe BEFORE bootstrap (BUG-085): bootstrap emits security/sandbox
// notices and git-updated. The host's WorkerEngineClient AsyncQueue buffers
// postMessage landings until the TUI attaches, so early events still reach
// the UI. Subscribing only after bootstrap dropped those notices forever.
const eventStream = engine.events() as AsyncIterable<UIEvent>;
void (async () => {
  for await (const event of eventStream) {
    port.postMessage(event);
  }
})();

await Promise.resolve();
bootstrapped = true;
for (const msg of inboundQueue.splice(0)) {
  await handleInbound(msg);
}

async function handleRpc(
  op: EngineWorkerRpcOp,
): Promise<EngineWorkerRpcResults[EngineWorkerRpcOp]> {
  switch (op) {
    case "snapshot":
      return engine.snapshot();
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
