import { test, expect } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import type { UIEvent, ToolDefinition } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";

/** Build a provider-level stream from LanguageModelV2 stream parts. */
function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({
      chunks: chunks as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

const echoTool: ToolDefinition<{ text: string }> = {
  name: "echo",
  description: "Echo the input text.",
  inputSchema: z.object({ text: z.string() }),
  readOnly: true,
  async execute({ text }) {
    return { output: `echoed: ${text}` };
  },
};

function mockRegistry(model: MockLanguageModelV2): ProviderRegistry {
  return new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => model,
      listModels: async () => [],
    },
  ]);
}

async function collect(
  bus: EventBus,
  run: () => Promise<void>,
): Promise<UIEvent[]> {
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();
  await run();
  bus.close();
  await collector;
  return events;
}

test("runs a full tool-call -> result -> final-text turn", async () => {
  // A counter-driven doStream avoids MockLanguageModelV2's array off-by-one.
  const steps = [
    // Step 1: the model calls the echo tool.
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "echo",
        input: JSON.stringify({ text: "hello" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    // Step 2: the model produces the final answer.
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "All " },
      { type: "text-delta", id: "t1", delta: "done." },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => steps[call++] as never,
  });

  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([echoTool]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  const events = await collect(bus, () => session.run("please echo hello"));
  const types = events.map((e) => e.type);

  expect(types).toContain("user-message");
  expect(types).toContain("tool-call-started");
  expect(types).toContain("tool-call-finished");
  expect(types).toContain("assistant-text-delta");
  expect(types).toContain("turn-finished");
  expect(types).toContain("session-idle");

  const toolStart = events.find((e) => e.type === "tool-call-started");
  expect(toolStart && toolStart.type === "tool-call-started" && toolStart.toolName).toBe("echo");

  const toolDone = events.find((e) => e.type === "tool-call-finished");
  expect(toolDone && toolDone.type === "tool-call-finished" && toolDone.output).toBe(
    "echoed: hello",
  );

  const text = events
    .filter((e): e is Extract<UIEvent, { type: "assistant-text-delta" }> =>
      e.type === "assistant-text-delta",
    )
    .map((e) => e.delta)
    .join("");
  expect(text).toBe("All done.");

  const snap = session.snapshot();
  expect(snap.history.at(-1)?.role).toBe("assistant");
  expect(snap.busy).toBe(false);
});

test("a deny permission rule blocks a side-effecting tool", async () => {
  const dangerTool: ToolDefinition<{ x: string }> = {
    name: "danger",
    description: "A side-effecting tool.",
    inputSchema: z.object({ x: z.string() }),
    readOnly: false,
    async execute() {
      throw new Error("danger should never execute when denied");
    },
  };

  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "danger",
        input: JSON.stringify({ x: "boom" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "ok" },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => steps[call++] as never,
  });

  const config = { ...defaultConfig(), permissions: [{ tool: "danger", action: "deny" as const }] };
  const bus = new EventBus();
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([dangerTool]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  const events = await collect(bus, () => session.run("do the dangerous thing"));
  expect(
    events.some((e) => e.type === "notice" && e.message.includes("Blocked danger")),
  ).toBe(true);
  expect(events.some((e) => e.type === "engine-error")).toBe(false);
});

test("emits engine-error when the provider is unconfigured", async () => {
  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: new ProviderRegistry(),
    toolset: new Toolset(),
    bus,
    cwd: process.cwd(),
    model: "anthropic/claude-opus-4-8",
    mode: "execute",
  });

  // Ensure no ambient key makes this provider "configured".
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const events = await collect(bus, () => session.run("hi"));
    expect(events.some((e) => e.type === "engine-error")).toBe(true);
    expect(events.some((e) => e.type === "session-idle")).toBe(true);
  } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  }
});
