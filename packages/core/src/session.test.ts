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

test("Anthropic's disjoint cache-read tokens are folded into input for cost + context", async () => {
  // Anthropic reports input_tokens EXCLUSIVE of cache reads. The mock emits the
  // provider shape: 10 new input tokens + 90 cache-read tokens (disjoint).
  const ANTHRO_USAGE = {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 105,
    cachedInputTokens: 90,
  };
  const model = new MockLanguageModelV2({
    doStream: async () =>
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "ok" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: ANTHRO_USAGE },
      ]) as never,
  });
  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    // Provider id must be "anthropic" for the disjoint-cache fold to engage.
    registry: new ProviderRegistry([
      { id: "anthropic", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
    ]),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "anthropic/claude-x",
    mode: "execute",
    // $3/1M input, $0.30/1M cache read.
    getPricing: async () => ({ input: 3, output: 15, cacheRead: 0.3 }),
  });

  const events = await collect(bus, () => session.run("go"));
  // Context fill reflects the FULL prompt (10 + 90 = 100), not just the 10 new.
  const ctx = [...events].reverse().find((e) => e.type === "context-updated");
  expect(ctx && ctx.type === "context-updated" && ctx.usedTokens).toBe(100);

  const usage = session.snapshot().usage;
  expect(usage.inputTokens).toBe(100); // folded: 10 new + 90 cached
  expect(usage.cachedInputTokens).toBe(90);
  // uncached 10*3/1e6 + cached 90*0.3/1e6 + out 5*15/1e6
  expect(usage.costUSD).toBeCloseTo(0.00003 + 0.000027 + 0.000075, 12);
});

test("a turn that fails before any assistant reply rolls back its user message (no orphan turn)", async () => {
  // The first turn's model resolution fails outright; its pushed user message must
  // be rolled back so the next turn's prompt doesn't open with two user messages
  // in a row (a hard 400 on strict providers, and a corrupt --resume seed).
  let failResolve = true;
  let sentPrompt: { role: string; content: unknown }[] = [];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      sentPrompt = options.prompt as { role: string; content: unknown }[];
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "ok" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never;
    },
  });
  const registry = new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => {
        if (failResolve) throw new Error("provider temporarily down");
        return model;
      },
      listModels: async () => [],
    },
  ]);
  const cfg = defaultConfig();
  cfg.retry = { ...cfg.retry, maxAttempts: 1, baseDelayMs: 0 }; // fail fast, no retry delay
  const bus = new EventBus();
  const session = new Session({
    config: cfg,
    registry,
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  await session.run("FIRST prompt"); // resolveModel throws → turn errors before any assistant
  expect(session.lastError).toContain("provider temporarily down");
  failResolve = false;
  await session.run("SECOND prompt"); // succeeds
  bus.close();

  // The successful turn's prompt carries exactly ONE user message (the second),
  // with the orphaned first turn rolled back and no two consecutive user roles.
  const userMsgs = sentPrompt.filter((m) => m.role === "user");
  expect(userMsgs).toHaveLength(1);
  expect(JSON.stringify(userMsgs[0]!.content)).toContain("SECOND prompt");
  expect(JSON.stringify(userMsgs[0]!.content)).not.toContain("FIRST prompt");
  const roles = sentPrompt.map((m) => m.role);
  for (let i = 1; i < roles.length; i++) {
    expect(roles[i] === "user" && roles[i - 1] === "user").toBe(false);
  }
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

test("image attachments reach the model as multimodal content", async () => {
  let captured: { prompt?: unknown[] } | null = null;
  const model = new MockLanguageModelV2({
    doStream: async (opts: { prompt?: unknown[] }) => {
      captured = opts;
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "ok" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never;
    },
  });

  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  await collect(bus, () =>
    session.run("look at this", [
      { path: "pic.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
    ]),
  );

  const prompt = (captured as { prompt?: unknown[] } | null)?.prompt ?? [];
  const userMsg = prompt.find(
    (m): m is { role: string; content: unknown } =>
      typeof m === "object" && m !== null && (m as { role?: string }).role === "user",
  );
  const content = (userMsg?.content ?? []) as Array<{ type?: string }>;
  // The AI SDK lowers an image part to a provider "file"/"image" content part.
  expect(
    Array.isArray(content) && content.some((p) => p.type === "file" || p.type === "image"),
  ).toBe(true);
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

test("compaction frees the reported context immediately (no stale provider count)", async () => {
  // Each turn reports a big provider input count, so #lastInputTokens climbs to
  // the PRE-compaction prompt size. After /compact drops most messages, the live
  // context must reflect the freed space at once — not stay pinned at the old
  // high value until the next turn runs a step.
  const BIG_USAGE = { inputTokens: 90_000, outputTokens: 5, totalTokens: 90_005 };
  const reply = (text: string) =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: BIG_USAGE },
    ]);
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => reply(`answer ${call++}`) as never,
    // /compact summarizes the older half via generateText.
    doGenerate: async () => ({
      content: [{ type: "text", text: "earlier work summarized." }],
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  });

  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    getContextWindow: async () => 128_000,
  });

  // Build up more than COMPACT_KEEP_RECENT (6) model messages so there is an
  // older half to summarize.
  for (let i = 0; i < 5; i++) await session.run(`turn ${i}`);
  expect(session.contextTokens).toBe(90_000); // pinned to the provider count

  const events = await collect(bus, () => session.compact());

  // After compaction the reported context drops to a fresh estimate of the
  // surviving messages — far below the stale 90k provider count — and a
  // context-updated event carries that lower number.
  expect(session.contextTokens).toBeLessThan(90_000);
  const ctxUpdate = events.findLast((e) => e.type === "context-updated");
  expect(ctxUpdate && ctxUpdate.type === "context-updated" && ctxUpdate.usedTokens).toBeLessThan(
    90_000,
  );
  expect(events.some((e) => e.type === "compacted")).toBe(true);
});
