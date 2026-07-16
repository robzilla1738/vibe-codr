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
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => model,
      listModels: async () => [],
    },
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
    execute: async () => ({ output: { value: 1, unit: "ms" }, isError: true }),
  } as unknown as ToolDefinition;
  const mediaResult = {
    name: "media_result",
    description: "returns content-form output",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => ({
      output: {
        type: "content",
        value: [
          { type: "text", text: "Readable result" },
          { type: "media", data: "base64-secret", mediaType: "image/png" },
        ],
      },
    }),
  } as unknown as ToolDefinition;
  const nestedMediaResult = {
    name: "nested_media_result",
    description: "returns nested media inside JSON output",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => ({
      output: {
        type: "json",
        value: {
          content: [
            { type: "text", text: "Readable nested result" },
            { type: "media", data: "nested-base64-secret", mediaType: "image/png" },
            { type: "file-data", data: "file-base64-secret", mediaType: "application/pdf" },
          ],
        },
      },
    }),
  } as unknown as ToolDefinition;
  const wrapperShapedResult = {
    name: "wrapper_shaped_result",
    description: "returns a raw object that resembles a provider envelope",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => ({ output: { type: "text", value: "literal payload" } }),
  } as unknown as ToolDefinition;
  const fileStatusResult = {
    name: "file_status_result",
    description: "returns a non-binary domain object with a file discriminator",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => ({ output: { type: "file", path: "src/a.ts", status: "changed" } }),
  } as unknown as ToolDefinition;

  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "f1", toolName: "flaky", input: JSON.stringify({}) },
      {
        type: "tool-call",
        toolCallId: "m1",
        toolName: "media_result",
        input: JSON.stringify({}),
      },
      {
        type: "tool-call",
        toolCallId: "m2",
        toolName: "nested_media_result",
        input: JSON.stringify({}),
      },
      {
        type: "tool-call",
        toolCallId: "m3",
        toolName: "wrapper_shaped_result",
        input: JSON.stringify({}),
      },
      {
        type: "tool-call",
        toolCallId: "m4",
        toolName: "file_status_result",
        input: JSON.stringify({}),
      },
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
  const hooks = new HookBus();
  hooks.on("tool.after.execute", (payload) =>
    payload.toolName === "media_result"
      ? { ...payload, additionalContext: "verified by the post-tool hook" }
      : payload,
  );

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([
      flaky,
      mediaResult,
      nestedMediaResult,
      wrapperShapedResult,
      fileStatusResult,
    ]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    hooks,
  });
  await session.run("call the flaky tool");
  bus.close();
  await done;

  const finished = events.find((e) => e.type === "tool-call-finished" && e.toolName === "flaky");
  expect(finished && finished.type === "tool-call-finished" && finished.isError).toBe(true);
  const persistedResult = session
    .snapshot()
    .history.flatMap((message) => message.parts)
    .find((part) => part.type === "tool-result" && part.toolCallId === "f1");
  expect(persistedResult?.type === "tool-result" && persistedResult.isError).toBe(true);
  expect(persistedResult?.type === "tool-result" ? String(persistedResult.output) : "").toContain(
    "unit",
  );
  const persistedMedia = session
    .snapshot()
    .history.flatMap((message) => message.parts)
    .find((part) => part.type === "tool-result" && part.toolCallId === "m1");
  const persistedMediaOutput =
    persistedMedia?.type === "tool-result" ? String(persistedMedia.output) : "";
  expect(persistedMediaOutput).toContain("Readable result");
  expect(persistedMediaOutput).toContain("[media omitted]");
  expect(persistedMediaOutput).not.toContain("base64-secret");
  expect(persistedMediaOutput).toContain("verified by the post-tool hook");
  const persistedNestedMedia = session
    .snapshot()
    .history.flatMap((message) => message.parts)
    .find((part) => part.type === "tool-result" && part.toolCallId === "m2");
  expect(
    persistedNestedMedia?.type === "tool-result" ? String(persistedNestedMedia.output) : "",
  ).toContain("[media omitted]");
  expect(
    persistedNestedMedia?.type === "tool-result" ? String(persistedNestedMedia.output) : "",
  ).not.toContain("nested-base64-secret");
  expect(
    persistedNestedMedia?.type === "tool-result" ? String(persistedNestedMedia.output) : "",
  ).not.toContain("file-base64-secret");
  expect(
    persistedNestedMedia?.type === "tool-result" ? String(persistedNestedMedia.output) : "",
  ).toContain("[binary omitted]");
  const persistedWrapper = session
    .snapshot()
    .history.flatMap((message) => message.parts)
    .find((part) => part.type === "tool-result" && part.toolCallId === "m3");
  expect(persistedWrapper?.type === "tool-result" ? persistedWrapper.output : null).toBe(
    '{"type":"text","value":"literal payload"}',
  );
  const persistedFileStatus = session
    .snapshot()
    .history.flatMap((message) => message.parts)
    .find((part) => part.type === "tool-result" && part.toolCallId === "m4");
  expect(persistedFileStatus?.type === "tool-result" ? persistedFileStatus.output : null).toBe(
    '{"type":"file","path":"src/a.ts","status":"changed"}',
  );
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
