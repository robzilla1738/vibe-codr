import { test, expect } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";

function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({
      chunks: chunks as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}
const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

test("spawn_subagent runs an isolated child and returns its result", async () => {
  // Calls are served in order: parent(spawn) -> child(text) -> parent(text).
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "s1",
        toolName: "spawn_subagent",
        input: JSON.stringify({ prompt: "research the thing" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "c" },
      { type: "text-delta", id: "c", delta: "child result" },
      { type: "text-end", id: "c" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "p" },
      { type: "text-delta", id: "p", delta: "parent done" },
      { type: "text-end", id: "p" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => steps[call++] as never,
  });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  const session = new Session({
    config: defaultConfig(),
    registry: new ProviderRegistry([
      { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
    ]),
    toolset: new Toolset([]), // only the per-session spawn tool is needed
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  await session.run("delegate the research");
  bus.close();
  await collector;

  const started = events.find((e) => e.type === "subagent-started");
  expect(started).toBeDefined();

  const finished = events.find((e) => e.type === "subagent-finished");
  expect(finished && finished.type === "subagent-finished" && finished.result).toBe(
    "child result",
  );

  // The subagent's result is fed back to the parent as the tool output.
  const toolDone = events.find(
    (e) => e.type === "tool-call-finished" && e.toolName === "spawn_subagent",
  );
  expect(toolDone && toolDone.type === "tool-call-finished" && toolDone.output).toBe(
    "child result",
  );

  // The parent only emits its own assistant text (child stream is isolated).
  const text = events
    .filter((e): e is Extract<UIEvent, { type: "assistant-text-delta" }> =>
      e.type === "assistant-text-delta",
    )
    .map((e) => e.delta)
    .join("");
  expect(text).toBe("parent done");
});
