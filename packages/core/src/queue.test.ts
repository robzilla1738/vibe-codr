import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { HookBus } from "@vibe/plugins";
import { defaultConfig } from "@vibe/config";
import { Engine } from "./engine.ts";

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

/** A model that replies with a fixed line, after an optional delay. */
function replyModel(delayMs = 0): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "ok" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop" as const, raw: undefined }, usage: USAGE },
        ] as never[],
        initialDelayInMs: delayMs,
        chunkDelayInMs: 0,
      }),
    }),
  });
}

function mockEngine(
  model: MockLanguageModelV3,
  hooks?: HookBus,
): { engine: Engine; events: UIEvent[] } {
  const registry = new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => model,
      listModels: async () => [],
    },
  ]);
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test" },
    registry,
    toolset: new Toolset([]),
    ...(hooks ? { hooks } : {}),
    cwd: mkdtempSync(join(tmpdir(), "vibe-queue-")), // isolated, non-git
  });
  const events: UIEvent[] = [];
  void (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  return { engine, events };
}

test("a prompt submitted while busy is queued, then runs in order", async () => {
  const { engine, events } = mockEngine(replyModel(5));

  engine.send({ type: "submit-prompt", text: "first task" });
  engine.send({ type: "submit-prompt", text: "second task" });
  await engine.whenIdle();

  // The backlog was surfaced while the first prompt was running.
  const queued = events.find(
    (e) => e.type === "queue-changed" && e.pending.some((p) => p.label === "second task"),
  );
  expect(queued).toBeDefined();

  // Both ran, in submission order.
  const prompts = events
    .filter((e): e is Extract<UIEvent, { type: "user-message" }> => e.type === "user-message")
    .map((e) => e.text);
  expect(prompts).toEqual(["first task", "second task"]);

  // The queue ends empty and idle.
  const last = [...events].reverse().find((e) => e.type === "queue-changed");
  expect(last && last.type === "queue-changed" && last.active).toBeNull();
  expect(last && last.type === "queue-changed" && last.pending.length).toBe(0);
});

test("/queue clear drops everything still waiting", async () => {
  const { engine, events } = mockEngine(replyModel(5));

  engine.send({ type: "submit-prompt", text: "A" });
  engine.send({ type: "submit-prompt", text: "B" });
  engine.send({ type: "submit-prompt", text: "C" });
  // Handled immediately (not queued): drops B and C, leaves A running.
  engine.send({ type: "run-slash", name: "queue", args: "clear" });
  await engine.whenIdle();

  const prompts = events
    .filter((e): e is Extract<UIEvent, { type: "user-message" }> => e.type === "user-message")
    .map((e) => e.text);
  expect(prompts).toEqual(["A"]);

  expect(events.some((e) => e.type === "notice" && e.message.includes("Cleared 2"))).toBe(true);
});

/** Poll the event log for the queue id of a waiting prompt with `label`. */
async function waitForQueueId(events: UIEvent[], label: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    for (const e of events) {
      if (e.type === "queue-changed") {
        const hit = e.pending.find((p) => p.label === label);
        if (hit) return hit.id;
      }
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`queued prompt "${label}" never surfaced`);
}

test("dequeue drops one specific waiting prompt without running it", async () => {
  const { engine, events } = mockEngine(replyModel(20));

  engine.send({ type: "submit-prompt", text: "A" });
  engine.send({ type: "submit-prompt", text: "B" });
  engine.send({ type: "submit-prompt", text: "C" });
  // Drop B while A is still running (B and C are queued behind it).
  const bid = await waitForQueueId(events, "B");
  engine.send({ type: "dequeue", id: bid });
  await engine.whenIdle();

  const prompts = events
    .filter((e): e is Extract<UIEvent, { type: "user-message" }> => e.type === "user-message")
    .map((e) => e.text);
  // A ran, B was removed, C still ran — and C kept its place after A.
  expect(prompts).toEqual(["A", "C"]);
});

test("steer jumps a queued prompt to the front and interrupts the running turn", async () => {
  const { engine, events } = mockEngine(replyModel(30));

  engine.send({ type: "submit-prompt", text: "A" });
  engine.send({ type: "submit-prompt", text: "B" });
  engine.send({ type: "submit-prompt", text: "C" });
  // Steer C: it should jump ahead of B and run next (A is interrupted).
  const cid = await waitForQueueId(events, "C");
  engine.send({ type: "steer", id: cid });
  await engine.whenIdle();

  const prompts = events
    .filter((e): e is Extract<UIEvent, { type: "user-message" }> => e.type === "user-message")
    .map((e) => e.text);
  // Nothing was dropped, and C was steered ahead of B.
  expect(prompts).toContain("C");
  expect(prompts).toContain("B");
  expect(prompts.indexOf("C")).toBeLessThan(prompts.indexOf("B"));
});

test("a throw outside the per-item catch doesn't wedge the queue", async () => {
  // The drain loop's per-item try/catch covers item.run() only. A session.idle
  // hook whose #onError ALSO throws escapes hooks.run into #maybeContinueOnIdle,
  // i.e. the drain loop OUTSIDE that catch. Without the drain's own try/finally,
  // #draining would stick true and every future #enqueue would silently no-op —
  // a permanent, invisible engine wedge. The finally must clear the latch and
  // still fire engine-idle so the queue keeps working.
  const hooks = new HookBus(() => {
    throw new Error("onError boom");
  });
  hooks.on("session.idle", () => {
    throw new Error("idle boom");
  });
  const { engine, events } = mockEngine(replyModel(5), hooks);

  engine.send({ type: "submit-prompt", text: "first" });
  await engine.whenIdle();
  // If the latch stuck true, this second prompt would never run.
  engine.send({ type: "submit-prompt", text: "second" });
  await engine.whenIdle();

  const prompts = events
    .filter((e): e is Extract<UIEvent, { type: "user-message" }> => e.type === "user-message")
    .map((e) => e.text);
  expect(prompts).toEqual(["first", "second"]);
  // engine-idle still fired despite the escaped throw (whenIdle resolved above).
  expect(events.some((e) => e.type === "engine-idle")).toBe(true);
});

test("abort clears the pending queue", async () => {
  const { engine, events } = mockEngine(replyModel(5));

  engine.send({ type: "submit-prompt", text: "one" });
  engine.send({ type: "submit-prompt", text: "two" });
  engine.send({ type: "abort" });
  await engine.whenIdle();

  const prompts = events
    .filter((e): e is Extract<UIEvent, { type: "user-message" }> => e.type === "user-message")
    .map((e) => e.text);
  // "two" was dropped from the queue by the abort.
  expect(prompts).toEqual(["one"]);
});

test("finalize sweeps queued work — it never runs a model turn post-teardown", async () => {
  // #doFinalize used to leave #pending intact and never abort the live turn, so a
  // dequeued item (loop iteration, goal round, typed-ahead prompt) would run a
  // full model turn AFTER teardown, against a closed bus and MCP hub. Finalize
  // now drops the queue (firing onCancel) and aborts the in-flight turn first.
  const { engine, events } = mockEngine(replyModel(50));

  engine.send({ type: "submit-prompt", text: "first" });
  engine.send({ type: "submit-prompt", text: "second" });
  // Finalize while "first" is still streaming and "second" is queued behind it.
  await engine.finalize();

  const prompts = events
    .filter((e): e is Extract<UIEvent, { type: "user-message" }> => e.type === "user-message")
    .map((e) => e.text);
  // "second" was swept by finalize and never started a turn.
  expect(prompts).not.toContain("second");
});

test("finalize waits for the in-flight queue item before teardown", async () => {
  const hooks = new HookBus(() => {});
  let releaseHook!: () => void;
  let hookStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    hookStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseHook = resolve;
  });
  hooks.on("user.prompt.submit", async (event) => {
    hookStarted();
    await release;
    return { text: event.text };
  });
  const { engine } = mockEngine(replyModel(0), hooks);

  engine.send({ type: "submit-prompt", text: "blocked" });
  await started;

  let finalized = false;
  const finalizing = engine.finalize().then(() => {
    finalized = true;
  });
  await Bun.sleep(10);
  expect(finalized).toBe(false);

  releaseHook();
  await finalizing;
  expect(finalized).toBe(true);
});

test("a prompt submitted DURING an async session.idle hook's await is not stranded", async () => {
  // Regression: when the session.idle hook is async (an HTTP/shell config hook
  // or any async in-process handler) and a prompt arrives during its await, the
  // outer drain loop exited on {continue:false} without re-checking #pending —
  // the prompt sat in the queue forever (engine-idle fired, #draining cleared,
  // but nothing re-triggered #drain). The fix: the outer loop condition also
  // checks #pending.length so items that arrived during the idle await are
  // drained before settling.
  const hooks = new HookBus(() => {});
  let idleHookInAwait: () => void;
  const idleHookStarted = new Promise<void>((r) => {
    idleHookInAwait = r;
  });
  hooks.on("session.idle", async () => {
    // Yield long enough for the test to inject a prompt during the await.
    idleHookInAwait!();
    await new Promise((r) => setTimeout(r, 50));
    return { sessionId: "", continue: false }; // do NOT request a continuation
  });

  const { engine, events } = mockEngine(replyModel(0), hooks);

  engine.send({ type: "submit-prompt", text: "first" });
  // Wait until the idle hook is IN its async await (the inner loop has already
  // exited and #maybeContinueOnIdle is suspended on the hook's promise).
  await idleHookStarted;
  // Inject a prompt during the hook's await — this is the race window.
  engine.send({ type: "submit-prompt", text: "second" });
  await engine.whenIdle();

  const prompts = events
    .filter((e): e is Extract<UIEvent, { type: "user-message" }> => e.type === "user-message")
    .map((e) => e.text);
  // The second prompt must not be stranded — it runs after the hook settles.
  expect(prompts).toEqual(["first", "second"]);
});

test("itemTimeoutMs: a stuck item is aborted and the queue continues", async () => {
  // A model whose stream NEVER resolves (no chunks, no error, no finish) — the
  // interactive stream-idle watchdog is off (it's only for headless), so without
  // itemTimeoutMs this would hang forever. The ceiling aborts the session turn,
  // the drain catches the timeout error, and the next prompt runs.
  // A model whose stream NEVER produces a chunk after stream-start and never
  // ends — a truly hung provider stream that the interactive idle-watchdog
  // doesn't cover (it's off for interactive). Without itemTimeoutMs the drain
  // loop would hang forever on `await item.run()`.
  const stuckModel = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          // Never enqueue another chunk or close — the stream hangs.
        },
      }),
    }),
  });
  const config = { ...defaultConfig(), model: "mock/test", itemTimeoutMs: 200 };
  const registry = new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => stuckModel,
      listModels: async () => [],
    },
  ]);
  const engine = new Engine({
    config,
    registry,
    toolset: new Toolset([]),
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  (async () => {
    for await (const e of engine.events()) events.push(e);
  })();

  engine.start();
  engine.send({ type: "submit-prompt", text: "stuck" });

  // Wait for the timeout to fire (200ms ceiling + overhead). The item should be
  // aborted and an engine-error emitted.
  await engine.whenIdle();
  // Let the event consumer process the engine-idle event (microtask hop).
  await new Promise((r) => setTimeout(r, 10));

  const errors = events.filter((e) => e.type === "engine-error");
  expect(errors.length).toBeGreaterThan(0);
  if (errors[0]?.type === "engine-error") {
    expect(errors[0].message).toContain("wall-clock ceiling");
  }

  // The queue should be idle (not stuck).
  expect(events.some((e) => e.type === "engine-idle")).toBe(true);

  // A second prompt should run normally (the queue wasn't wedged).
  expect(engine.queueState().active).toBeNull();
  expect(engine.queueState().pending).toHaveLength(0);
});
