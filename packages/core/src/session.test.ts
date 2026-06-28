import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import type { UIEvent, ToolDefinition } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";
import { SessionStore } from "./store.ts";

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

test("persists after a turn and can be resumed with prior context", async () => {
  const reply = (text: string) =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]);
  let call = 0;
  const replies = [reply("first answer"), reply("second answer")];
  const model = new MockLanguageModelV2({
    doStream: async () => replies[call++] as never,
  });

  const cwd = mkdtempSync(join(tmpdir(), "vibe-resume-"));
  const store = new SessionStore(cwd);
  const registry = mockRegistry(model);
  const bus = new EventBus();

  const first = new Session({
    config: defaultConfig(),
    registry,
    toolset: new Toolset([]),
    bus,
    cwd,
    model: "mock/test",
    mode: "execute",
    store,
    id: "ses_resume",
  });
  await first.run("remember the number 42");

  const persisted = await store.load("ses_resume");
  expect(persisted).not.toBeNull();
  expect(persisted!.meta.model).toBe("mock/test");
  expect(persisted!.modelMessages.length).toBeGreaterThanOrEqual(2);
  expect(persisted!.history.at(-1)?.role).toBe("assistant");

  // Resume into a fresh session and continue the conversation.
  const resumed = new Session({
    config: defaultConfig(),
    registry,
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd,
    model: persisted!.meta.model,
    mode: persisted!.meta.mode,
    store,
    id: persisted!.meta.id,
    initialModelMessages: persisted!.modelMessages,
    initialHistory: persisted!.history,
  });
  await resumed.run("what was the number?");
  // The resumed session retained the prior turn plus the new exchange.
  expect(resumed.messageCount).toBeGreaterThanOrEqual(4);
});

test("accumulates per-step usage and prices it (no double-counting)", async () => {
  // Two steps, each reporting USAGE (10 in / 5 out). onStepFinish usage is
  // per-step, so the turn total must be the SUM, not a cumulative re-count.
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "echo", input: JSON.stringify({ text: "x" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "done" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });

  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([echoTool]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    getPricing: async () => ({ input: 3, output: 15 }), // USD per 1M tokens
  });

  const events = await collect(bus, () => session.run("go"));
  const last = [...events].reverse().find((e) => e.type === "usage-updated");
  expect(last && last.type === "usage-updated" && last.usage.totalTokens).toBe(30);

  const usage = session.snapshot().usage;
  expect(usage.inputTokens).toBe(20); // 2 steps × 10
  expect(usage.outputTokens).toBe(10); // 2 steps × 5
  // 20/1e6*3 + 10/1e6*15 = 0.00006 + 0.00015
  expect(usage.costUSD).toBeCloseTo(0.00021, 9);
});

test("cost accrues at the price in effect per step, across a model switch", async () => {
  const reply = () =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "ok" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE }, // 10 in / 5 out
    ]);
  let call = 0;
  const replies = [reply(), reply()];
  const model = new MockLanguageModelV2({ doStream: async () => replies[call++] as never });

  const prices: Record<string, { input: number; output: number }> = {
    "mock/cheap": { input: 1, output: 1 },
    "mock/dear": { input: 10, output: 10 },
  };
  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/cheap",
    mode: "execute",
    getPricing: async (m) => prices[m],
  });

  await session.run("first"); // priced cheap: 15 tok × $1/1M = 0.000015
  session.setModel("mock/dear");
  await session.run("second"); // priced dear: 15 tok × $10/1M = 0.00015
  bus.close();

  // Accrual = 0.000015 + 0.00015, NOT 30 tok × $10/1M (= 0.0003).
  expect(session.snapshot().usage.costUSD).toBeCloseTo(0.000165, 9);
});

test("spend guard with onExceed=stop aborts after the budget is crossed", async () => {
  // Step 1 is a tool call (reports usage); the huge price trips a tiny budget,
  // so the turn must abort before the final-text step 2 runs.
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "echo", input: JSON.stringify({ text: "x" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "SHOULD-NOT-APPEAR" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });

  const config = {
    ...defaultConfig(),
    budget: { limitUSD: 0.0001, onExceed: "stop" as const },
  };
  const bus = new EventBus();
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([echoTool]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    getPricing: async () => ({ input: 1000, output: 1000 }),
  });

  const events = await collect(bus, () => session.run("go"));
  expect(
    events.some((e) => e.type === "notice" && e.message.includes("Spend limit")),
  ).toBe(true);
  const text = events
    .filter((e): e is Extract<UIEvent, { type: "assistant-text-delta" }> =>
      e.type === "assistant-text-delta",
    )
    .map((e) => e.delta)
    .join("");
  expect(text).not.toContain("SHOULD-NOT-APPEAR");
});

test("spend guard with onExceed=warn notifies once but completes the turn", async () => {
  const reply = () =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "done" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]);
  let call = 0;
  const replies = [reply()];
  const model = new MockLanguageModelV2({ doStream: async () => replies[call++] as never });

  const config = {
    ...defaultConfig(),
    budget: { limitUSD: 0.0001, onExceed: "warn" as const },
  };
  const bus = new EventBus();
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    getPricing: async () => ({ input: 1000, output: 1000 }),
  });

  const events = await collect(bus, () => session.run("go"));
  const notices = events.filter(
    (e) => e.type === "notice" && e.message.includes("Spend limit"),
  );
  expect(notices.length).toBe(1); // warned exactly once
  const text = events
    .filter((e): e is Extract<UIEvent, { type: "assistant-text-delta" }> =>
      e.type === "assistant-text-delta",
    )
    .map((e) => e.delta)
    .join("");
  expect(text).toBe("done"); // turn still completed
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
