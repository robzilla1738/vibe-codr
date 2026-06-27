import { test, expect } from "bun:test";
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
