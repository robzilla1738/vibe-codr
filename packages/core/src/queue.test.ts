import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
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

function mockEngine(model: MockLanguageModelV2): { engine: Engine; events: UIEvent[] } {
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
