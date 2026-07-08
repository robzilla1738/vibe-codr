import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerEngineClient, type WorkerEngineOptions } from "./engine-worker-client.ts";

/**
 * End-to-end `WorkerEngineClient` contract tests. We DON'T drive a real
 * `Engine` here — that's the territory of `engine-*.test.ts` in
 * `@vibe/core`, which constructs the in-process Engine directly. These
 * tests verify the WIRE PROTOCOL the host-client and worker-entry agree
 * on: events forwarded into the consumer's `events()` queue, RPC
 * request/reply correlation, fatal-sentinel → `onFatal`, and finalize
 * teardown semantics.
 *
 * The stub worker is a tiny TS file written into a tmpdir and spawned by
 * path so we exercise the real `worker_threads` `MessagePort` boundary
 * (structured-clone, macrotask delivery) — same path the production
 * `engine-worker-entry.ts` takes.
 */

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

/** Write a stub worker into a tmpdir + return its path. The stub speaks the
 *  same protocol as `engine-worker-entry.ts` minus the Engine itself. */
function writeStubWorker(body: string): string {
  tmpDir = mkdtempSync(join(tmpdir(), "vibe-worker-test-"));
  const path = join(tmpDir, "stub-worker.ts");
  const code = `
import { parentPort, workerData } from "node:worker_threads";
// Forward env as the production entry does — verifies host→worker env passes.
if (workerData?.env) for (const [k,v] of Object.entries(workerData.env)) if (v !== undefined) process.env[k] = v;
${body}
`;
  writeFileSync(path, code);
  return path;
}

/** Build options with a fatal handler that records the message. */
function makeOpts(workerPath: string, workerData: unknown): WorkerEngineOptions {
  return {
    workerPath,
    workerData: workerData as WorkerEngineOptions["workerData"],
    onFatal: (m) => fatalMessages.push(m),
    env: { ...process.env },
    inheritStderr: false,
  };
}

const fatalMessages: string[] = [];
afterEach(() => fatalMessages.length = 0);

test("events() forwards UIEvents the worker posts, in order", async () => {
  const path = writeStubWorker(`
parentPort.postMessage({ type: "user-message", sessionId: "s1", text: "hi" });
parentPort.postMessage({ type: "assistant-text-delta", sessionId: "s1", delta: "world" });
parentPort.postMessage({ type: "turn-finished", sessionId: "s1" });
`);
  const client = await createWorkerEngineClient(makeOpts(path, {}));
  let n = 0;
  for await (const e of client.events()) {
    n++;
    if (n === 1) expect(e.type).toBe("user-message");
    if (n === 2) expect((e as { delta: string }).delta).toBe("world");
    if (n === 3) break;
  }
  expect(n).toBe(3);
  await client.finalize();
});

test("RPC snapshots / listModels round-trip", async () => {
  const path = writeStubWorker(`
parentPort.on("message", (m) => {
  if (m.__req) {
    parentPort.postMessage({ __resp: m.__req, ok: true, value: stub(m.op) });
  }
});
function stub(op) {
  if (op === "snapshot") return { sessionId: "x", model: "stub/m", mode: "execute" };
  if (op === "listModels") return [{ id: "m", providerId: "stub", name: "Stub" }];
  if (op === "listProviders") return [{ id: "stub", configured: true, keyless: false, env: ["STUB_KEY"] }];
  if (op === "listAgents") return [];
  if (op === "listSkills") return [];
  if (op === "finalize") return undefined;
}
`);
  const client = await createWorkerEngineClient(makeOpts(path, {}));
  const models = await client.listModels();
  expect(models).toEqual([{ id: "m", providerId: "stub", name: "Stub" }]);
  const providers = await client.listProviders();
  expect(providers).toEqual([{ id: "stub", configured: true, keyless: false, env: ["STUB_KEY"] }]);
  // BUG-084: createWorkerEngineClient awaits ready() so the first snapshot()
  // is the real engine state (model/approvalMode/theme), not a placeholder.
  const snap = client.snapshot();
  expect(snap.model).toBe("stub/m");
  await client.finalize();
});

test("ready snapshot carries approvalMode auto (BUG-084 YOLO chrome)", async () => {
  const path = writeStubWorker(`
parentPort.on("message", (m) => {
  if (m.__req) {
    if (m.op === "snapshot") {
      parentPort.postMessage({
        __resp: m.__req,
        ok: true,
        value: {
          sessionId: "s",
          model: "openai/gpt-4",
          mode: "execute",
          approvalMode: "auto",
          goal: null,
          history: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
          tasks: [],
          busy: false,
          theme: "tokyonight",
          accentColor: "#ff0000",
          commandNames: ["help"],
        },
      });
      return;
    }
    parentPort.postMessage({ __resp: m.__req, ok: true, value: m.op === "listModels" ? [] : undefined });
  }
});
`);
  const client = await createWorkerEngineClient(makeOpts(path, {}));
  const snap = client.snapshot();
  expect(snap.model).toBe("openai/gpt-4");
  expect(snap.approvalMode).toBe("auto");
  expect(snap.theme).toBe("tokyonight");
  expect(snap.accentColor).toBe("#ff0000");
  await client.finalize();
});

test("mode-changed invalidates cache; snapshot() re-RPCs real commandNames (BUG-084)", async () => {
  // After mode-changed clears #snapshotCache, a lazy re-RPC must refill it.
  // Without that, refreshStatus would see PLACEHOLDER.commandNames=[] and wipe
  // the slash-command cue; busy:false would also lie about mid-turn state.
  const path = writeStubWorker(`
let snaps = 0;
parentPort.on("message", (m) => {
  if (!m.__req) return;
  if (m.op === "snapshot") {
    snaps += 1;
    const n = snaps;
    parentPort.postMessage({
      __resp: m.__req,
      ok: true,
      value: {
        sessionId: "s",
        model: "m",
        mode: n === 1 ? "execute" : "plan",
        approvalMode: "ask",
        goal: null,
        history: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
        tasks: [],
        busy: n > 1,
        theme: "default",
        accentColor: "",
        commandNames: n === 1 ? ["help"] : ["help", "status", "diff"],
      },
    });
    return;
  }
  parentPort.postMessage({ __resp: m.__req, ok: true, value: undefined });
});
// After hydrate, simulate a live mode change (what set-mode emits).
setTimeout(() => {
  parentPort.postMessage({ type: "mode-changed", mode: "plan" });
}, 30);
`);
  const client = await createWorkerEngineClient(makeOpts(path, {}));
  // First paint is real (hydrate).
  expect(client.snapshot().commandNames).toEqual(["help"]);
  expect(client.snapshot().busy).toBe(false);

  // Wait for the mode-changed event to land and invalidate the cache.
  let sawMode = false;
  for await (const e of client.events()) {
    if (e.type === "mode-changed") {
      sawMode = true;
      break;
    }
  }
  expect(sawMode).toBe(true);

  // Cache miss → re-RPC fires; after the worker replies, snapshot is real again.
  let snap = client.snapshot(); // triggers re-RPC (may still be placeholder briefly)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 15));
    snap = client.snapshot();
    if (snap.commandNames?.includes("status") && snap.busy === true) break;
  }
  expect(snap.mode).toBe("plan");
  expect(snap.busy).toBe(true);
  expect(snap.commandNames).toEqual(["help", "status", "diff"]);
  // Must NOT be stuck on the empty placeholder.
  expect(snap.commandNames.length).toBeGreaterThan(0);
  await client.finalize();
});

test("RPC error reply rejects the promise", async () => {
  const path = writeStubWorker(`
parentPort.on("message", (m) => {
  if (m.__req) parentPort.postMessage({ __resp: m.__req, ok: false, error: "boom" });
});
`);
  const client = await createWorkerEngineClient(makeOpts(path, {}));
  await expect(client.listModels()).rejects.toThrow("boom");
  // A failure shouldn't frame the worker as closed — finalize still works.
  // The stub doesn't know `finalize` either; that RPC will also reject,
  // which finalize silently absorbs (best-effort teardown).
  await client.finalize();
  expect(fatalMessages).toEqual([]);
});

test("__fatal__ sentinel fires onFatal and closes the events stream", async () => {
  const path = writeStubWorker(`
parentPort.postMessage({ __fatal__: true, message: "synthetic crash" });
`);
  const client = await createWorkerEngineClient(makeOpts(path, {}));
  let count = 0;
  for await (const _e of client.events()) count++;
  expect(count).toBe(0); // stream closed without any events
  expect(fatalMessages).toContain("synthetic crash");
});

test("worker error event surfaces as fatal", async () => {
  const path = writeStubWorker(`
// Throw a synchronous error AFTER the host attaches listeners so it routes
// through Worker's 'error' event rather than crashing before subscribe.
setTimeout(() => { throw new Error("sync throw"); }, 10);
`);
  const client = await createWorkerEngineClient(makeOpts(path, {}));
  let count = 0;
  for await (const _e of client.events()) count++;
  expect(count).toBe(0);
  expect(fatalMessages.length).toBeGreaterThan(0);
});

test("send(command) is forwarded verbatim to the worker", async () => {
  const path = writeStubWorker(`
parentPort.on("message", (m) => {
  // Echo any non-RPC message back as a UIEvent carrying the command verbatim;
  // ACK any RPC so finalize() doesn't hang waiting on a stub that ignores it.
  if (m.__req) parentPort.postMessage({ __resp: m.__req, ok: true, value: undefined });
  else parentPort.postMessage({ type: "engine-idle", sessionId: "rx", command: m });
});
`);
  const client = await createWorkerEngineClient(makeOpts(path, {}));
  // Send a command — the stub echoes it back inside a UIEvent on receipt.
  client.send({ type: "set-mode", mode: "plan" });
  let echoed: { command: unknown } | null = null;
  for await (const e of client.events()) {
    if ((e as { command?: unknown }).command) {
      echoed = e as { command: unknown };
      break;
    }
  }
  expect(echoed!.command).toEqual({ type: "set-mode", mode: "plan" });
  await client.finalize();
});

test("events() is structured-clone-safe — Uint8Array round-trips", async () => {
  const path = writeStubWorker(`
const bytes = new Uint8Array([1,2,3,255,0]);
// tool-call-finished.output is typed unknown — a natural carrier for binary
// payloads (image @mentions, captured bytes). Structured-clone preserves
// typed-array identity across the MessagePort boundary.
parentPort.postMessage({ type: "tool-call-finished", toolCallId: "t1", output: { bytes }, isError: false });
parentPort.postMessage({ type: "turn-finished", sessionId: "s" });
`);
  const client = await createWorkerEngineClient(makeOpts(path, {}));
  let n = 0;
  for await (const e of client.events()) {
    n++;
    if (n === 1) {
      const output = (e as { output: { bytes: Uint8Array } }).output;
      expect(output.bytes instanceof Uint8Array).toBe(true);
      expect(Array.from(output.bytes)).toEqual([1, 2, 3, 255, 0]);
    }
    if (n === 2) break;
  }
  await client.finalize();
});

test("finalize terminates the worker; the events stream closes", async () => {
  const path = writeStubWorker(`
parentPort.on("message", (m) => {
  if (!m.__req) return;
  if (m.op === "snapshot") {
    return parentPort.postMessage({
      __resp: m.__req,
      ok: true,
      value: {
        sessionId: "s",
        model: "m",
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
      },
    });
  }
  if (m.op === "finalize") return parentPort.postMessage({ __resp: m.__req, ok: true, value: undefined });
  parentPort.postMessage({ __resp: m.__req, ok: true, value: undefined });
});
`);
  const client = await createWorkerEngineClient(makeOpts(path, {}));
  // Drain any subscribe messages first (none) — then finalize.
  await client.finalize();
  let count = 0;
  for await (const _e of client.events()) count++;
  // Finalize closed the AsyncQueue — the for-await terminates with no events.
  expect(count).toBe(0);
});