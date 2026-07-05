import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { HookBus } from "@vibe/plugins";
import { defaultConfig } from "@vibe/config";
import { Engine } from "./engine.ts";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** A model that replies with a fixed line, after an optional delay. */
function replyModel(delayMs = 0): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "ok" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ] as never[],
        initialDelayInMs: delayMs,
        chunkDelayInMs: 0,
      }),
    }),
  });
}

function mockEngine(
  model: MockLanguageModelV2,
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

  expect(
    events.some((e) => e.type === "notice" && e.message.includes("Cleared 2")),
  ).toBe(true);
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
