import { test, expect } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import type { ToolDefinition, UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { FreshnessRegistry } from "@vibe/tools";
import { HookBus } from "@vibe/plugins";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";

function mockRegistry(model: MockLanguageModelV2) {
  return new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
}

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

function collect(bus: EventBus): { events: UIEvent[]; done: Promise<void> } {
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const done = (async () => {
    for await (const e of sub) events.push(e);
  })();
  return { events, done };
}

test("a tool's isError result is reported as a failed tool call (not a success)", async () => {
  // Handled errors come back as ordinary string results, so the SDK's tool-result
  // part has no error flag. The adapter's side-channel must mark it so the UI
  // doesn't render a failure as a green tick.
  const flaky = {
    name: "flaky",
    description: "always reports an error",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => ({ output: "it broke", isError: true }),
  } as unknown as ToolDefinition;

  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "f1", toolName: "flaky", input: JSON.stringify({}) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "p" },
      { type: "text-delta", id: "p", delta: "noted" },
      { type: "text-end", id: "p" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([flaky]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  await session.run("call the flaky tool");
  bus.close();
  await done;

  const finished = events.find(
    (e) => e.type === "tool-call-finished" && e.toolName === "flaky",
  );
  expect(finished && finished.type === "tool-call-finished" && finished.isError).toBe(true);
});

test("under budget=stop, a second prompt is refused without an orphan user turn", async () => {
  const config = {
    ...defaultConfig(),
    budget: { limitUSD: 0.000_001, onExceed: "stop" as const },
  };
  // Price so a single token blows the tiny limit on the first turn.
  const model = new MockLanguageModelV2({
    doStream: async () =>
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "p" },
        { type: "text-delta", id: "p", delta: "spent" },
        { type: "text-end", id: "p" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never,
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  let calls = 0;
  const session = new Session({
    config,
    registry: new ProviderRegistry([
      {
        id: "mock",
        auth: { env: [], keyless: true },
        create: () => {
          calls++;
          return model;
        },
        listModels: async () => [],
      },
    ]),
    toolset: new Toolset([]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    getPricing: async () => ({ input: 1_000_000, output: 1_000_000 }),
  });

  await session.run("first prompt");
  const afterFirst = session.messageCount;
  const callsAfterFirst = calls;

  await session.run("second prompt should be blocked");
  bus.close();
  await done;

  // The blocked turn appended no message (no consecutive user turns) and never
  // hit the model again.
  expect(session.messageCount).toBe(afterFirst);
  expect(calls).toBe(callsAfterFirst);
  const blocked = events.find(
    (e) => e.type === "notice" && /blocked/i.test(e.message) && /spend limit/i.test(e.message),
  );
  expect(blocked).toBeDefined();
});

test("setProjectMemory is reflected in the next turn's system prompt", async () => {
  const systems: string[] = [];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      systems.push(JSON.stringify(options.prompt));
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "p" },
        { type: "text-delta", id: "p", delta: "ok" },
        { type: "text-end", id: "p" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never;
    },
  });
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  session.setProjectMemory("PROJECT-MEMORY-MARKER-XYZ");
  await session.run("hi");
  expect(systems[0]).toContain("PROJECT-MEMORY-MARKER-XYZ");
});

test("the step.finish hook fires at each step boundary", async () => {
  const fires: string[] = [];
  const hooks = new HookBus();
  hooks.on("step.finish", (p) => {
    fires.push(p.sessionId);
  });
  const model = new MockLanguageModelV2({
    doStream: async () =>
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "p" },
        { type: "text-delta", id: "p", delta: "done" },
        { type: "text-end", id: "p" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never,
  });
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    hooks,
  });
  await session.run("hi");
  expect(fires.length).toBeGreaterThanOrEqual(1);
  expect(fires[0]).toBe(session.id);
});

test("a user cancel is not surfaced as an engine error", async () => {
  // The model aborts the turn mid-stream then the stream rejects (as it does on
  // a real Esc/steer). That must be classified as an interrupt, not a fault.
  let theSession: Session;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      theSession.abort();
      const err = Object.assign(new Error("Aborted"), { name: "AbortError" });
      throw err;
    },
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  theSession = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  await theSession.run("do a thing then cancel");
  bus.close();
  await done;

  expect(events.find((e) => e.type === "engine-error")).toBeUndefined();
  expect(theSession.interrupted).toBe(true);
  expect(theSession.lastError).toBeNull();
});
