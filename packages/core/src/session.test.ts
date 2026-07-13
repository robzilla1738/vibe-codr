import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import type { UIEvent, ToolDefinition, Message } from "@vibe/shared";
import type { ModelMessage } from "ai";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { FreshnessRegistry } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";
import { SessionStore } from "./store.ts";
import { estimateTokens } from "./compaction.ts";

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

async function collect(bus: EventBus, run: () => Promise<void>): Promise<UIEvent[]> {
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
    freshness: new FreshnessRegistry(),
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
    .filter(
      (e): e is Extract<UIEvent, { type: "assistant-text-delta" }> =>
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
    freshness: new FreshnessRegistry(),
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
    freshness: new FreshnessRegistry(),
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

test("resume hydrates the offloaded map so prune keeps live artifact paths", async () => {
  // meta.offloaded is persisted for --resume fidelity; without wiring it into
  // SessionDeps.initialOffloaded the map is empty after resume and prune can
  // delete still-referenced artifacts once the dir exceeds maxArtifactBytes.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-resume-offload-"));
  const store = new SessionStore(cwd);
  const model = new MockLanguageModelV2({
    doStream: async () =>
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "ok" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]),
  });
  const offloaded = [
    { callId: "call_old", path: join(cwd, "art.txt"), toolName: "read", fullChars: 50_000 },
  ];
  const first = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
    store,
    id: "ses_off",
    initialOffloaded: offloaded,
  });
  // Force a persist so meta.offloaded is written.
  await first.run("ping");
  const persisted = await store.load("ses_off");
  expect(persisted!.meta.offloaded).toEqual(offloaded);

  const resumed = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    freshness: new FreshnessRegistry(),
    cwd,
    model: persisted!.meta.model,
    mode: persisted!.meta.mode,
    store,
    id: persisted!.meta.id,
    initialModelMessages: persisted!.modelMessages,
    initialHistory: persisted!.history,
    initialOffloaded: persisted!.meta.offloaded,
  });
  // Internal: the restored map must be non-empty — re-persist and assert the
  // same callId is still listed (proves constructor hydrated #offloaded).
  await resumed.run("pong");
  const again = await store.load("ses_off");
  expect(again!.meta.offloaded?.some((r) => r.callId === "call_old")).toBe(true);
});

test("resume seeds the real prior prompt size so the first turn's compaction check isn't overhead-blind", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-resume-ctx-"));
  const store = new SessionStore(cwd);
  const model = new MockLanguageModelV2({
    doStream: async () =>
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "ok" },
        { type: "text-end", id: "t" },
        // A big REAL input count — the true context fill the estimate can't see.
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 90_000, outputTokens: 5, totalTokens: 90_005 },
        },
      ]),
  });
  const first = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
    store,
    id: "ses_ctx",
  });
  await first.run("go");
  expect(first.contextTokens).toBe(90_000);

  const persisted = await store.load("ses_ctx");
  // The real prior prompt size round-trips through persistence…
  expect(persisted!.meta.lastInputTokens).toBe(90_000);

  // …and a resumed session reports it BEFORE its first step, instead of the
  // small messages-only estimate (which omits ~40k of system/tool overhead and
  // would let an over-window prompt sail past the compaction trigger).
  const resumed = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    freshness: new FreshnessRegistry(),
    cwd,
    model: persisted!.meta.model,
    mode: persisted!.meta.mode,
    store,
    id: persisted!.meta.id,
    initialModelMessages: persisted!.modelMessages,
    initialHistory: persisted!.history,
    initialLastInputTokens: persisted!.meta.lastInputTokens,
  });
  expect(resumed.contextTokens).toBe(90_000);
});

/**
 * BUG-112: between-turn compaction must use estimate + #overheadTokens once
 * overhead is known. The pre-fix formula max(lastInputTokens, estimate) stuck
 * at the PREVIOUS step's full prompt size (which omits the just-pushed user
 * turn) and skipped compaction that should fire when a large paste lands.
 *
 * Numbers chosen so the two formulas disagree:
 *   window=10k, threshold=0.75 → fire at ≥7500
 *   after turn 1: lastInputTokens=5000, overhead ≈ 5000 − small msg est
 *   large paste: estimate ≈ 3k → max(5000, 3k)=5000 < 7500 (old: no compact)
 *                 estimate + overhead ≈ 8k ≥ 7500 (new: compact)
 */
test("BUG-112: auto-compact uses estimate+overhead when a large paste lands after a high lastInputTokens step", async () => {
  const WINDOW = 10_000;
  const THRESHOLD = 0.75; // fire at 7500
  const PRIOR_INPUT = 5_000;
  const LARGE = "L".repeat(12_000); // ~3000 tokens of message text

  let summarizeCalls = 0;
  const model = new MockLanguageModelV2({
    doStream: async () =>
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "ok" },
        { type: "text-end", id: "t" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: PRIOR_INPUT, outputTokens: 5, totalTokens: PRIOR_INPUT + 5 },
        },
      ]) as never,
    doGenerate: async () => {
      summarizeCalls++;
      return {
        content: [
          {
            type: "text",
            text: "## STATE\nprior work\n## DECISIONS\nnone\n## FILES TOUCHED\nnone\n## OPEN\nnone",
          },
        ],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });

  const cfg = defaultConfig();
  cfg.compaction = { ...cfg.compaction, threshold: THRESHOLD };
  // Keep offload from interfering with the between-turn path under test.
  cfg.compaction.offload = { ...cfg.compaction.offload, enabled: false };

  const bus = new EventBus();
  const session = new Session({
    config: cfg,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: mkdtempSync(join(tmpdir(), "vibe-bug112-")),
    model: "mock/test",
    mode: "execute",
    getContextWindow: async () => WINDOW,
  });

  // Turn 1: short prompt; provider reports PRIOR_INPUT so overhead is measured.
  await session.run("go");
  expect(session.contextTokens).toBe(PRIOR_INPUT);

  // Preconditions for the disagreement: after push of LARGE, estimate alone
  // stays under the fire line when max'd with lastInputTokens, but
  // estimate+overhead crosses it. We measure against the messages that WILL be
  // present (prior transcript + large user) via the same estimateTokens helper
  // the session uses.
  const priorMsgs = [
    { role: "user" as const, content: "go" },
    { role: "assistant" as const, content: "ok" },
  ];
  const afterPushEst = estimateTokens([...priorMsgs, { role: "user", content: LARGE }]);
  const oldTrigger = Math.max(PRIOR_INPUT, afterPushEst);
  // overhead ≈ PRIOR_INPUT − estimate(sent); lower-bound it with PRIOR_INPUT − afterPushEst
  // is wrong — use PRIOR_INPUT − small prior estimate as a conservative floor.
  const priorEst = estimateTokens(priorMsgs);
  const minOverhead = Math.max(0, PRIOR_INPUT - priorEst);
  const newTrigger = afterPushEst + minOverhead;
  expect(oldTrigger).toBeLessThan(THRESHOLD * WINDOW); // old formula would NOT fire
  expect(newTrigger).toBeGreaterThanOrEqual(THRESHOLD * WINDOW); // new formula MUST fire

  const events = await collect(bus, () => session.run(LARGE));
  expect(summarizeCalls).toBeGreaterThan(0);
  expect(events.some((e) => e.type === "compacted")).toBe(true);
});

/**
 * BUG-118: on --resume, #overheadTokens must be recomputed from
 * lastInputTokens − estimate(messages) so the first mid-turn / between-turn
 * projection is not overhead-blind (overhead stayed 0 until a step finished).
 * This drives the constructor recompute + the same estimate+overhead compact
 * path as BUG-112, seeded only via resume fields (no prior live step).
 */
test("BUG-118: resume recomputes overhead so a large paste auto-compacts without a prior live step", async () => {
  const WINDOW = 10_000;
  const THRESHOLD = 0.75;
  const PRIOR_INPUT = 5_000;
  const LARGE = "R".repeat(12_000);

  const seedMessages: ModelMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "ok" },
  ];
  const seedEst = estimateTokens(seedMessages);
  const overhead = Math.max(0, PRIOR_INPUT - seedEst);
  expect(overhead).toBeGreaterThan(0);

  const afterPushEst = estimateTokens([...seedMessages, { role: "user", content: LARGE }]);
  expect(Math.max(PRIOR_INPUT, afterPushEst)).toBeLessThan(THRESHOLD * WINDOW);
  expect(afterPushEst + overhead).toBeGreaterThanOrEqual(THRESHOLD * WINDOW);

  let summarizeCalls = 0;
  const model = new MockLanguageModelV2({
    doStream: async () =>
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "ok" },
        { type: "text-end", id: "t" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
        },
      ]) as never,
    doGenerate: async () => {
      summarizeCalls++;
      return {
        content: [
          {
            type: "text",
            text: "## STATE\nresumed\n## DECISIONS\nnone\n## FILES TOUCHED\nnone\n## OPEN\nnone",
          },
        ],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });

  const cfg = defaultConfig();
  cfg.compaction = { ...cfg.compaction, threshold: THRESHOLD };
  cfg.compaction.offload = { ...cfg.compaction.offload, enabled: false };

  const bus = new EventBus();
  // Resume path only — no live prior step. Constructor must recompute overhead
  // from lastInputTokens + messages or the compact trigger stays under threshold.
  const session = new Session({
    config: cfg,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: mkdtempSync(join(tmpdir(), "vibe-bug118-")),
    model: "mock/test",
    mode: "execute",
    getContextWindow: async () => WINDOW,
    initialModelMessages: seedMessages,
    initialHistory: [
      { id: "m1", role: "user", parts: [{ type: "text", text: "go" }], createdAt: 1 },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "ok" }], createdAt: 2 },
    ] as Message[],
    initialLastInputTokens: PRIOR_INPUT,
  });
  expect(session.contextTokens).toBe(PRIOR_INPUT);

  const events = await collect(bus, () => session.run(LARGE));
  // Without constructor overhead recompute, max(5000, ~3k) never crosses 7500
  // and summarize is never called. With recompute, estimate+overhead fires.
  expect(summarizeCalls).toBeGreaterThan(0);
  expect(events.some((e) => e.type === "compacted")).toBe(true);
});

test("accumulates per-step usage and prices it (no double-counting)", async () => {
  // Two steps, each reporting USAGE (10 in / 5 out). onStepFinish usage is
  // per-step, so the turn total must be the SUM, not a cumulative re-count.
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "echo",
        input: JSON.stringify({ text: "x" }),
      },
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
    freshness: new FreshnessRegistry(),
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
      {
        id: "anthropic",
        auth: { env: [], keyless: true },
        create: () => model,
        listModels: async () => [],
      },
    ]),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
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
    freshness: new FreshnessRegistry(),
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
    freshness: new FreshnessRegistry(),
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
    freshness: new FreshnessRegistry(),
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
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "echo",
        input: JSON.stringify({ text: "x" }),
      },
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
    freshness: new FreshnessRegistry(),
    model: "mock/test",
    mode: "execute",
    getPricing: async () => ({ input: 1000, output: 1000 }),
  });

  const events = await collect(bus, () => session.run("go"));
  expect(events.some((e) => e.type === "notice" && e.message.includes("Spend limit"))).toBe(true);
  const text = events
    .filter(
      (e): e is Extract<UIEvent, { type: "assistant-text-delta" }> =>
        e.type === "assistant-text-delta",
    )
    .map((e) => e.delta)
    .join("");
  expect(text).not.toContain("SHOULD-NOT-APPEAR");
});

test("spend guard with onExceed=stop does NOT block the next turn on ESTIMATED spend", async () => {
  // An estimated (base-model fallback) price must never hard-stop — not in-turn
  // AND not at the pre-turn gate. A local tag that fuzzy-matched a cloud rate
  // could otherwise refuse every future turn of a genuinely-free session.
  const reply = (delta: string) =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      },
    ]);
  const replies = [reply("first"), reply("SECOND-RAN")];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => replies[call++] as never });
  const bus = new EventBus();
  const session = new Session({
    config: { ...defaultConfig(), budget: { limitUSD: 0.0001, onExceed: "stop" as const } },
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
    model: "mock/test",
    mode: "execute",
    // ESTIMATED price → big enough to cross the tiny budget on turn 1.
    getPricing: async () => ({ input: 1000, output: 1000, estimated: true }),
  });

  await collect(bus, () => session.run("turn one")); // crosses the (estimated) budget
  const events = await collect(bus, () => session.run("turn two")); // must NOT be refused
  const blocked = events.some(
    (e) => e.type === "notice" && e.message.includes("new turns are blocked"),
  );
  expect(blocked).toBe(false);
  const text = events
    .filter(
      (e): e is Extract<UIEvent, { type: "assistant-text-delta" }> =>
        e.type === "assistant-text-delta",
    )
    .map((e) => e.delta)
    .join("");
  expect(text).toContain("SECOND-RAN");
});

test("pre-turn spend guard blocks on prior actual spend even after switching to an estimated-price model", async () => {
  const reply = (delta: string) =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      },
    ]);
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => [reply("first"), reply("SHOULD-NOT-RUN")][call++] as never,
  });
  const bus = new EventBus();
  const session = new Session({
    config: { ...defaultConfig(), budget: { limitUSD: 0.0001, onExceed: "stop" as const } },
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
    model: "mock/actual",
    mode: "execute",
    getPricing: async (m) =>
      m === "mock/estimated"
        ? { input: 1000, output: 1000, estimated: true }
        : { input: 1000, output: 1000 },
  });

  await collect(bus, () => session.run("turn one"));
  session.setModel("mock/estimated");
  const events = await collect(bus, () => session.run("turn two"));
  const blocked = events.some(
    (e) => e.type === "notice" && e.message.includes("new turns are blocked"),
  );
  expect(blocked).toBe(true);
  expect(call).toBe(1);
});

test("pre-turn spend guard does not block estimated prior spend after switching to an actual-price model", async () => {
  const reply = (delta: string) =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      },
    ]);
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => [reply("first"), reply("SECOND-RAN")][call++] as never,
  });
  const bus = new EventBus();
  const session = new Session({
    config: { ...defaultConfig(), budget: { limitUSD: 0.0001, onExceed: "stop" as const } },
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
    model: "mock/estimated",
    mode: "execute",
    getPricing: async (m) =>
      m === "mock/estimated"
        ? { input: 1000, output: 1000, estimated: true }
        : { input: 1000, output: 1000 },
  });

  await collect(bus, () => session.run("turn one"));
  session.setModel("mock/actual");
  const events = await collect(bus, () => session.run("turn two"));
  const blocked = events.some(
    (e) => e.type === "notice" && e.message.includes("new turns are blocked"),
  );
  expect(blocked).toBe(false);
  const text = events
    .filter(
      (e): e is Extract<UIEvent, { type: "assistant-text-delta" }> =>
        e.type === "assistant-text-delta",
    )
    .map((e) => e.delta)
    .join("");
  expect(text).toContain("SECOND-RAN");
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
    freshness: new FreshnessRegistry(),
    model: "mock/test",
    mode: "execute",
    getPricing: async () => ({ input: 1000, output: 1000 }),
  });

  const events = await collect(bus, () => session.run("go"));
  const notices = events.filter((e) => e.type === "notice" && e.message.includes("Spend limit"));
  expect(notices.length).toBe(1); // warned exactly once
  const text = events
    .filter(
      (e): e is Extract<UIEvent, { type: "assistant-text-delta" }> =>
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
    freshness: new FreshnessRegistry(),
    model: "mock/test",
    mode: "execute",
  });

  const events = await collect(bus, () => session.run("do the dangerous thing"));
  expect(events.some((e) => e.type === "notice" && e.message.includes("Blocked danger"))).toBe(
    true,
  );
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
    freshness: new FreshnessRegistry(),
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
    freshness: new FreshnessRegistry(),
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

test("/clear resets token + offload accounting (no stale contextTokens or poisoned meta) (BUG-046)", async () => {
  // After a long session the provider's last input count (`#lastInputTokens`), the
  // system/tool scaffolding (`#overheadTokens`), the projection anchor
  // (`#lastSentEstimate`), and the offload map (`#offloaded`) are all populated.
  // `clear()` wiped the messages but left those pinned — `context-updated` and
  // `/context` reported a fill the empty transcript no longer had, `#maybeCompact`
  // could spuriously fire on the next short prompt, `#persist` wrote poisoned
  // `lastInputTokens` into meta for `--resume`, and the stale `#offloaded` map
  // made re-emitted previews look like duplicates (over-aggressive offload on
  // the next `prepareStep`). The fix resets every field and posts a fresh
  // `context-updated` so the UI and the next compaction see the freed space.
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
  const model = new MockLanguageModelV2({ doStream: async () => reply(`turn ${call++}`) as never });

  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: mkdtempSync(join(tmpdir(), "vibe-clear-acct-")),
    model: "mock/test",
    mode: "execute",
    getContextWindow: async () => 128_000,
  });
  for (let i = 0; i < 5; i++) await session.run(`turn ${i}`);
  expect(session.contextTokens).toBe(90_000); // pinned at the provider's count
  expect(session.messageCount).toBeGreaterThan(0);

  const events = await collect(bus, () => Promise.resolve(session.clear()));

  expect(session.messageCount).toBe(0);
  expect(session.contextTokens).toBe(0); // fresh estimate of empty ≈ 0
  const ctxUpdate = events.findLast((e) => e.type === "context-updated");
  expect(ctxUpdate && ctxUpdate.type === "context-updated" && ctxUpdate.usedTokens).toBe(0);

  // A short follow-up should NOT fire a bogus compaction (stale `#lastInputTokens`
  // was the trigger of the pre-fix bug — `#maybeCompact` saw ~90k above the
  // threshold and tried to compact an empty transcript).
  const follow = await collect(bus, () => session.run("hi"));
  expect(follow.some((e) => e.type === "compacted")).toBe(false);
});

test("a failing summarizer skips compaction with a notice instead of failing the turn", async () => {
  // The summarizer (generateText) is an AUXILIARY call. A transient failure on it
  // must NOT abort the turn (or mark a subagent fork as failed) — compaction is
  // skipped and the turn proceeds on the uncompacted context.
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
    // The summarizer call throws (transient provider error).
    doGenerate: async () => {
      throw new Error("summarizer upstream 503");
    },
  });
  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
    model: "mock/test",
    mode: "execute",
    getContextWindow: async () => 128_000,
  });
  for (let i = 0; i < 5; i++) await session.run(`turn ${i}`);
  // /compact must resolve (not reject) and emit a warn notice; history is intact.
  const before = session.contextTokens;
  const events = await collect(bus, () => session.compact());
  const notice = events.findLast((e) => e.type === "notice");
  expect(notice && notice.type === "notice" && notice.level).toBe("warn");
  expect(notice && notice.type === "notice" && notice.message).toContain("Compaction skipped");
  // The session is still usable — no engine-error, context unchanged (not dropped).
  expect(events.some((e) => e.type === "engine-error")).toBe(false);
  expect(session.contextTokens).toBe(before);
});

test("the compaction summarizer uses the sectioned contract and caps its input", async () => {
  const BIG_USAGE = { inputTokens: 90_000, outputTokens: 5, totalTokens: 90_005 };
  const reply = (text: string) =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: BIG_USAGE },
    ]);
  const prompts: string[] = [];
  const model = new MockLanguageModelV2({
    doStream: async () => reply("x".repeat(9_000)) as never,
    doGenerate: async (options) => {
      const p = (options as { prompt: { content: unknown }[] }).prompt;
      prompts.push(JSON.stringify(p));
      return {
        content: [{ type: "text", text: "## STATE\nok" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
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
    getContextWindow: async () => 128_000,
  });
  // 8 turns × 9k chars of reply → far over the 24k summarizer cap.
  for (let i = 0; i < 8; i++) await session.run(`turn ${i}`);
  await session.compact();

  expect(prompts).toHaveLength(1);
  const prompt = prompts[0]!;
  // Sectioned contract present.
  for (const section of [
    "## STATE",
    "## DECISIONS",
    "## FILES TOUCHED",
    "## VERIFIED FACTS",
    "## OPEN THREADS",
  ]) {
    expect(prompt).toContain(section);
  }
  // Input capped: the omission marker is present and the prompt is bounded well
  // below the raw ~50k+ transcript (24k cap + instruction overhead + JSON escaping).
  expect(prompt).toContain("chars of mid-conversation omitted");
  expect(prompt.length).toBeLessThan(40_000);
});

test("model failover: an unresolvable primary switches to the first working fallback, visibly", async () => {
  const model = new MockLanguageModelV2({
    doStream: async () =>
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "answered on the fallback" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never,
  });
  // Registry knows only "mock" — resolving "deadprov/x" throws; fallback chain
  // lists another dead one first, then the working mock model.
  const config = defaultConfig();
  config.retry = { maxAttempts: 0, baseDelayMs: 0 };
  config.modelFallbacks = ["alsodead/y", "mock/test"];
  const bus = new EventBus();
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
    model: "deadprov/x",
    mode: "execute",
  });
  const events = await collect(bus, () => session.run("hello"));
  expect(session.lastError).toBeNull();
  expect(session.model).toBe("mock/test"); // switched, not silently substituted
  expect(events.some((e) => e.type === "model-changed" && e.model === "mock/test")).toBe(true);
  expect(events.some((e) => e.type === "notice" && e.message.includes("failing over"))).toBe(true);
});

test("model failover: no resolvable fallback keeps the original error", async () => {
  const config = defaultConfig();
  config.retry = { maxAttempts: 0, baseDelayMs: 0 };
  config.modelFallbacks = ["alsodead/y"];
  const session = new Session({
    config,
    registry: new ProviderRegistry([]),
    toolset: new Toolset([]),
    bus: new EventBus(),
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "deadprov/x",
    mode: "execute",
  });
  await session.run("hello");
  expect(session.lastError).toBeTruthy();
});

test("an interrupted turn keeps completed tool steps in the transcript (a resume knows the work)", async () => {
  // Before the fix, an abort mid-turn dropped the COMPLETED step's tool_use +
  // tool_result (result.response rejects), so a resumed session had no record a
  // tool already ran — e.g. a file it already edited.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-interrupt-"));
  const store = new SessionStore(cwd);
  let sessionRef!: Session;
  const stopTool: ToolDefinition<Record<string, never>> = {
    name: "stop_now",
    description: "aborts the turn",
    inputSchema: z.object({}),
    readOnly: true,
    async execute() {
      sessionRef.abort(); // interrupt AFTER step 1 completed
      return { output: "stopping" };
    },
  };
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "echo",
        input: JSON.stringify({ text: "remember-this" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c2", toolName: "stop_now", input: "{}" },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "SHOULD-NOT-REACH" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const bus = new EventBus();
  sessionRef = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([echoTool, stopTool]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
    store,
    id: "ses_interrupt",
  });
  await collect(bus, () => sessionRef.run("do the thing"));

  const persisted = await store.load("ses_interrupt");
  const json = JSON.stringify(persisted!.modelMessages);
  // The completed step-1 tool call AND its result survived the interrupt.
  expect(json).toContain("remember-this"); // the tool-call input
  expect(json).toContain("echoed: remember-this"); // the tool RESULT
  // The user prompt was retained (we made progress → not rolled back as an orphan).
  expect(persisted!.modelMessages[0]!.role).toBe("user");
  // Transcript validity: a `tool` message never LEADS (every result follows its call).
  const roles = persisted!.modelMessages.map((m) => m.role);
  expect(roles[0]).not.toBe("tool");
  // Exactly one echo tool-result (no duplication from cumulative step buffering).
  expect(json.split("echoed: remember-this").length - 1).toBe(1);
});

test("a persisted session stamps the SessionMeta schema version", async () => {
  const { SESSION_META_VERSION } = await import("./store.ts");
  const cwd = mkdtempSync(join(tmpdir(), "vibe-ver-"));
  const store = new SessionStore(cwd);
  const model = new MockLanguageModelV2({
    doStream: async () =>
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "ok" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never,
  });
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
    store,
    id: "ses_ver",
  });
  await session.run("go");
  const persisted = await store.load("ses_ver");
  expect(persisted!.meta.version).toBe(SESSION_META_VERSION);
});

test("rewindConversation returns the sliced-off tail and restoreConversation re-appends it (round-trip)", () => {
  // FIX 1 primitive: /undo truncates the model context to a mark and must hand back
  // the discarded tail so /redo can move it forward again in lockstep with files.
  const msg = (id: string, role: "user" | "assistant", text: string): Message => ({
    id,
    role,
    parts: [{ type: "text", text }],
    createdAt: 0,
  });
  const modelMessages: ModelMessage[] = [
    { role: "user", content: "one" },
    { role: "assistant", content: "1" },
    { role: "user", content: "two" },
    { role: "assistant", content: "2" },
  ];
  const history: Message[] = [
    msg("h1", "user", "one"),
    msg("h2", "assistant", "1"),
    msg("h3", "user", "two"),
    msg("h4", "assistant", "2"),
  ];
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(new MockLanguageModelV2({ doStream: async () => stream([]) as never })),
    toolset: new Toolset([]),
    bus: new EventBus(),
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    initialModelMessages: modelMessages,
    initialHistory: history,
  });

  expect(session.messageCount).toBe(4);
  expect(session.snapshot().history.length).toBe(4);

  // Rewind to the /undo mark (before the last exchange) — captures the tail.
  const tail = session.rewindConversation({ messages: 2, history: 2 });
  expect(tail).toBeDefined();
  expect(tail!.modelMessages.length).toBe(2);
  expect(tail!.history.length).toBe(2);
  expect(session.messageCount).toBe(2);
  expect(session.snapshot().history.length).toBe(2);

  // /redo re-appends the tail → the conversation is byte-for-byte whole again.
  session.restoreConversation(tail!);
  expect(session.messageCount).toBe(4);
  expect(session.snapshot().history.map((m) => m.id)).toEqual(["h1", "h2", "h3", "h4"]);

  // A mark already at/after the current length discards nothing → no tail.
  expect(session.rewindConversation({ messages: 4, history: 4 })).toBeUndefined();
});

test("a NoOutputGeneratedError without an abort is a fault (lastError set, not interrupted)", async () => {
  // #isAbortError must NOT treat NoOutputGeneratedError as a cancel on its own:
  // a genuine provider no-output failure (never aborted) is a fault. Painting it
  // as interrupt would suppress lastError and leave a goal run armed-but-idle
  // behind the interrupted guard with no pause reason.
  const model = new MockLanguageModelV2({
    doStream: async () => {
      throw Object.assign(new Error("no output generated"), { name: "NoOutputGeneratedError" });
    },
  });
  const cfg = defaultConfig();
  cfg.retry = { ...cfg.retry, maxAttempts: 0, baseDelayMs: 0 };
  const bus = new EventBus();
  const session = new Session({
    config: cfg,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
    model: "mock/test",
    mode: "execute",
  });
  await session.run("go");
  bus.close();
  expect(session.interrupted).toBe(false);
  expect(session.lastError).toContain("No output generated");
});

test("a stalled provider stream aborts via the watchdog and surfaces lastError (headless)", async () => {
  // A half-open stream (a part arrives, then nothing — no finish, no error)
  // would hang the turn forever. In a non-interactive run the chunk-idle watchdog
  // aborts it and the catch routes to lastError (a fault), not interrupted.
  const model = new MockLanguageModelV2({
    doStream: async () => ({
      // Emit a start part, then never close the stream — a stall.
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "partial" });
          // deliberately no finish + never close: the reader blocks here.
        },
      }) as never,
    }),
  });
  const cfg = defaultConfig();
  cfg.streamIdleTimeoutMs = 50; // tiny watchdog for the test
  cfg.retry = { ...cfg.retry, maxAttempts: 0, baseDelayMs: 0 };
  const bus = new EventBus();
  const session = new Session({
    config: cfg,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
    model: "mock/test",
    mode: "execute",
    // interactive omitted → falsy → the watchdog is active (headless path).
  });
  await session.run("go");
  bus.close();
  expect(session.interrupted).toBe(false);
  expect(session.lastError).toContain("stalled");
});

test("an interactive session does NOT arm the stream-idle watchdog", async () => {
  // Interactive streams go legitimately silent during tool runs / permission
  // waits; Esc covers a wedged turn. The watchdog must not fire and auto-abort a
  // legitimately-slow interactive turn. A slow-but-completing stream finishes
  // cleanly with no lastError even though its gap exceeds the tiny timeout.
  const model = new MockLanguageModelV2({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "ok" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ] as never[],
        initialDelayInMs: 120, // exceeds the 50ms timeout below
        chunkDelayInMs: 0,
      }),
    }),
  });
  const cfg = defaultConfig();
  cfg.streamIdleTimeoutMs = 50;
  const bus = new EventBus();
  const session = new Session({
    config: cfg,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
    model: "mock/test",
    mode: "execute",
    interactive: true, // watchdog disabled
  });
  await session.run("go");
  bus.close();
  expect(session.interrupted).toBe(false);
  expect(session.lastError).toBeNull();
});

test("orphan rollback after emergency compaction re-binds userMsgRef (BUG-087)", async () => {
  // Emergency keep=1 (messages.length <= COMPACT_KEEP_RECENT=6 after push) folds
  // the just-pushed user into a NEW object. Without rebind after #maybeCompact,
  // identity-matched orphan rollback skips the pop → consecutive user messages.
  //
  // Seeds must be ≤5 so after pushUser length is ≤6 (the emergency gate). Six
  // seeds → length 7 > keep → normal keep-window path keeps the user BY REF and
  // this test becomes theater (passes without the rebind).
  const huge = "H".repeat(8_000);
  let failStream = true;
  let summarizeCalls = 0;
  let sentPrompt: { role: string }[] = [];
  const model = new MockLanguageModelV2({
    // #summarize uses generateText → doGenerate. Must SUCCEED so emergency
    // compact actually replaces messages (otherwise rebind is never exercised).
    doGenerate: async () => {
      summarizeCalls += 1;
      return {
        content: [
          {
            type: "text",
            text:
              "## STATE\ncompacted\n## DECISIONS\nnone\n## FILES TOUCHED\nnone\n" +
              "## VERIFIED FACTS\nnone\n## OPEN THREADS\nnone",
          },
        ],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        warnings: [],
      } as never;
    },
    doStream: async (options) => {
      sentPrompt = (options.prompt as { role: string }[]) ?? [];
      if (failStream) throw new Error("stream boom after compact");
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "ok" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never;
    },
  });
  const cfg = defaultConfig();
  cfg.compaction = { ...cfg.compaction, threshold: 0.01 };
  const bus = new EventBus();
  const session = new Session({
    config: cfg,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
    model: "mock/test",
    mode: "execute",
    getContextWindow: async () => 2_000,
    // 4 seeds + 1 push = 5 ≤ keep(6) → emergency keep=1 + fold creates NEW user object.
    initialModelMessages: [
      { role: "user", content: huge },
      { role: "assistant", content: huge },
      { role: "user", content: huge },
      { role: "assistant", content: huge },
    ] as ModelMessage[],
  });

  await session.run("ORPHAN-AFTER-COMPACT prompt that must be rolled back");
  expect(session.lastError).toBeTruthy();
  // Prove emergency compact actually ran (summarize → doGenerate).
  expect(summarizeCalls).toBeGreaterThanOrEqual(1);
  failStream = false;
  await session.run("SECOND clean prompt");
  bus.close();

  const roles = sentPrompt.map((m) => m.role);
  for (let i = 1; i < roles.length; i++) {
    expect(roles[i] === "user" && roles[i - 1] === "user").toBe(false);
  }
  expect(JSON.stringify(sentPrompt)).toContain("SECOND clean prompt");
  // The aborted first user text must be gone — only true if orphan pop ran on
  // the post-compact (re-bound) message object.
  expect(JSON.stringify(sentPrompt)).not.toContain("ORPHAN-AFTER-COMPACT");
});

test("resume does not promote estimated spend into actual hard-stop (BUG-103)", async () => {
  // Live path: estimated spend over the limit must not hard-stop.
  // Resume used to seed actualCostUSD from costUSD, so the NEXT turn blocked.
  const reply = (delta: string) =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      },
    ]);
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => [reply("first"), reply("AFTER-RESUME")][call++] as never,
  });
  const bus = new EventBus();
  const live = new Session({
    config: { ...defaultConfig(), budget: { limitUSD: 0.0001, onExceed: "stop" as const } },
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
    model: "mock/estimated",
    mode: "execute",
    getPricing: async () => ({ input: 1000, output: 1000, estimated: true }),
  });
  await collect(bus, () => live.run("turn one"));
  expect(live.costUSD).toBeGreaterThan(0.0001);
  expect(live.actualCostUSD).toBe(0);
  expect(live.costEstimated).toBe(true);

  // Simulate --resume with the fields a real persist writes (and the legacy
  // costUSD-only meta: actualCostUSD omitted + costEstimated true).
  const resumed = new Session({
    config: { ...defaultConfig(), budget: { limitUSD: 0.0001, onExceed: "stop" as const } },
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
    model: "mock/estimated",
    mode: "execute",
    initialCostUSD: live.costUSD,
    initialActualCostUSD: live.actualCostUSD,
    initialCostEstimated: live.costEstimated,
    getPricing: async () => ({ input: 1000, output: 1000, estimated: true }),
  });
  expect(resumed.actualCostUSD).toBe(0);
  expect(resumed.costEstimated).toBe(true);
  const events = await collect(bus, () => resumed.run("turn two"));
  const blocked = events.some(
    (e) => e.type === "notice" && e.message.includes("new turns are blocked"),
  );
  expect(blocked).toBe(false);
  const text = events
    .filter(
      (e): e is Extract<UIEvent, { type: "assistant-text-delta" }> =>
        e.type === "assistant-text-delta",
    )
    .map((e) => e.delta)
    .join("");
  expect(text).toContain("AFTER-RESUME");
});

test("resume with costEstimated flag alone keeps actual at 0 (BUG-103 legacy meta)", () => {
  // Meta that has costUSD + costEstimated but no actualCostUSD (forward-compat).
  const s = new Session({
    config: { ...defaultConfig(), budget: { limitUSD: 0.0001, onExceed: "stop" as const } },
    registry: mockRegistry(
      new MockLanguageModelV2({
        doStream: async () =>
          stream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "x" },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ]) as never,
      }),
    ),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: process.cwd(),
    freshness: new FreshnessRegistry(),
    model: "mock/x",
    mode: "execute",
    initialCostUSD: 5,
    initialCostEstimated: true,
  });
  expect(s.costUSD).toBe(5);
  expect(s.actualCostUSD).toBe(0);
  expect(s.costEstimated).toBe(true);
});
