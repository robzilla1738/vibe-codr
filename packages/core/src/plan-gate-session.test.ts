import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { ToolDefinition, UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset, presentPlanTool } from "@vibe/tools";
import { FreshnessRegistry } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";

process.env.VIBE_STATE_DIR ??= mkdtempSync(join(tmpdir(), "vibe-state-"));

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

/** A fake keyless web_search: read-only, so it survives the plan-mode filter. */
const fakeSearch: ToolDefinition<{ query: string }> = {
  name: "web_search",
  description: "fake",
  inputSchema: z.object({ query: z.string() }),
  readOnly: true,
  concurrencySafe: true,
  execute: async () => ({
    output: "1. Morocco vs Spain tonight\n   https://fifa.com/todays-match\n   Kickoff 20:00.",
  }),
};

const fakeFetch: ToolDefinition<{ url: string }> = {
  name: "webfetch",
  description: "fake",
  inputSchema: z.object({ url: z.string() }),
  readOnly: true,
  concurrencySafe: true,
  execute: async () => ({ output: "Match details: Morocco vs Spain tonight at 20:00." }),
};

const fakePkg: ToolDefinition<{ name: string }> = {
  name: "package_info",
  description: "fake",
  inputSchema: z.object({ name: z.string() }),
  readOnly: true,
  concurrencySafe: true,
  execute: async () => ({ output: "next@15.0.0\ntailwindcss@3.4.0" }),
};

const groundedPlan = {
  plan:
    "- [ ] Scaffold a next.js site for tonight's Morocco vs Spain match\n" +
    "- [ ] Verify with a production build\n",
  sources: [{ url: "https://fifa.com/todays-match", title: "Match page" }],
  assumptions: ["exact lineup unknown until kickoff"],
  verification: "next build",
  decisions: ["next.js — matches the request's stack"],
};

// The full code-enforced grounding loop, end to end through a REAL Session in
// plan mode: an ungrounded present_plan on a time-sensitive request is
// REJECTED with instructions; after real research the same call passes and
// the plan-presented event carries the sources.
test("plan gate: ungrounded present_plan is rejected, research + sources make it pass", async () => {
  const steps = [
    // Step 1: the model tries to present immediately (the gemma failure mode).
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "p1",
        toolName: "present_plan",
        input: JSON.stringify({ plan: "Build a site about today's match." }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    // Step 2: bounced — so it actually researches (search + fetch + package).
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "s1",
        toolName: "web_search",
        input: JSON.stringify({ query: "world cup match today" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "f1",
        toolName: "webfetch",
        input: JSON.stringify({ url: "https://fifa.com/todays-match" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "k1",
        toolName: "package_info",
        input: JSON.stringify({ name: "next" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    // Step 5: presents again, grounded and citing its source.
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "p2",
        toolName: "present_plan",
        input: JSON.stringify(groundedPlan),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Plan presented." },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: new ProviderRegistry([
      { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
    ]),
    toolset: new Toolset([presentPlanTool, fakeSearch, fakeFetch, fakePkg]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: mkdtempSync(join(tmpdir(), "vibe-plangate-")),
    model: "mock/test",
    mode: "plan",
  });

  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();
  await session.run("build a next.js site about today's world cup match");
  bus.close();
  await collector;

  // The first (ungrounded) present was rejected with actionable instructions…
  const results = events.filter(
    (e): e is Extract<UIEvent, { type: "tool-call-finished" }> => e.type === "tool-call-finished",
  );
  const firstPresent = results.find((r) => r.toolCallId === "p1");
  expect(firstPresent?.isError).toBe(true);
  expect(String(firstPresent?.output)).toContain("web_search");
  // …and did NOT surface a plan card.
  const plans = events.filter(
    (e): e is Extract<UIEvent, { type: "plan-presented" }> => e.type === "plan-presented",
  );
  expect(plans.length).toBe(1);
  // The grounded present passed, carrying its evidence.
  expect(plans[0]!.plan).toContain("Morocco");
  expect(plans[0]!.sources).toEqual([{ url: "https://fifa.com/todays-match", title: "Match page" }]);
  expect(plans[0]!.assumptions).toEqual(["exact lineup unknown until kickoff"]);
  expect(plans[0]!.ungrounded).toBeUndefined();
});

// A mid-turn mode switch (Shift+Tab / plan-card accept while the plan turn is
// still streaming) retires #planGate on the Session — but the in-flight turn's
// planGate closure must keep working off the gate it started with instead of
// exploding on the now-undefined field.
test("plan gate survives a mid-turn mode switch away from plan", async () => {
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "s1",
        toolName: "web_search",
        input: JSON.stringify({ query: "world cup match today" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "f1",
        toolName: "webfetch",
        input: JSON.stringify({ url: "https://fifa.com/todays-match" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "k1",
        toolName: "package_info",
        input: JSON.stringify({ name: "next" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "p1",
        toolName: "present_plan",
        input: JSON.stringify(groundedPlan),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Plan presented." },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const bus = new EventBus();
  let session: Session;
  const flippingSearch: ToolDefinition<{ query: string }> = {
    ...fakeSearch,
    execute: async () => {
      session.setMode("execute"); // user flips mode while the plan turn streams
      return { output: "1. Morocco vs Spain tonight\n   https://fifa.com/todays-match" };
    },
  };
  session = new Session({
    config: defaultConfig(),
    registry: new ProviderRegistry([
      { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
    ]),
    toolset: new Toolset([presentPlanTool, flippingSearch, fakeFetch, fakePkg]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: mkdtempSync(join(tmpdir(), "vibe-plangate-flip-")),
    model: "mock/test",
    mode: "plan",
  });

  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();
  await session.run("build a next.js site about today's world cup match");
  bus.close();
  await collector;

  const present = events.find(
    (e): e is Extract<UIEvent, { type: "tool-call-finished" }> =>
      e.type === "tool-call-finished" && e.toolCallId === "p1",
  );
  // Grounded research happened, so the present must succeed — not throw on
  // a retired gate.
  expect(present?.isError).toBeFalsy();
  expect(events.some((e) => e.type === "plan-presented")).toBe(true);
});

// A web_search that surfaced NOTHING must not count as grounding — a junk query
// (zero results) can't satisfy the gate's "you researched" requirement.
test("plan gate: a zero-result web_search does not satisfy the grounding requirement", async () => {
  const emptySearch: ToolDefinition<{ query: string }> = {
    ...fakeSearch,
    execute: async () => ({ output: 'No results for "zzz qqq".' }),
  };
  const steps = [
    // Step 1: a junk search that finds nothing.
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "s1", toolName: "web_search", input: JSON.stringify({ query: "zzz qqq" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    // Step 2: try to present with a fabricated source — must be REJECTED.
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "p1",
        toolName: "present_plan",
        input: JSON.stringify({ plan: "Build it.", sources: [{ url: "https://example.com/made-up" }] }),
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
    registry: new ProviderRegistry([
      { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
    ]),
    toolset: new Toolset([presentPlanTool, emptySearch]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: mkdtempSync(join(tmpdir(), "vibe-plangate-empty-")),
    model: "mock/test",
    mode: "plan",
  });
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();
  await session.run("build a site about today's world cup match");
  bus.close();
  await collector;

  const present = events.find(
    (e): e is Extract<UIEvent, { type: "tool-call-finished" }> =>
      e.type === "tool-call-finished" && e.toolCallId === "p1",
  );
  // The zero-result search didn't count → the gate still demands real research.
  expect(present?.isError).toBe(true);
  expect(String(present?.output)).toMatch(/web_search|webfetch/i);
});
