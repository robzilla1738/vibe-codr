import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { ToolDefinition, UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset, presentPlanTool } from "@vibe/tools";
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

// The full code-enforced grounding loop, end to end through a REAL Session in
// plan mode: an ungrounded present_plan on a time-sensitive request is
// REJECTED with instructions; after a real web_search the same call passes and
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
    // Step 2: bounced — so it actually searches.
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
    // Step 3: presents again, grounded and citing its source.
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "p2",
        toolName: "present_plan",
        input: JSON.stringify({
          plan: "Build a site about tonight's Morocco vs Spain match.",
          sources: [{ url: "https://fifa.com/todays-match", title: "Match page" }],
          assumptions: ["exact lineup unknown until kickoff"],
        }),
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
    toolset: new Toolset([presentPlanTool, fakeSearch]),
    bus,
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
