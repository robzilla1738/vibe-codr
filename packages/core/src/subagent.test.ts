import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";
import { SessionStore } from "./store.ts";

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

  // The child's tokens are folded into the parent so /cost and the spend guard
  // account for delegated work: parent's own 2 steps (2+2) + child's 1 step (2).
  expect(session.snapshot().usage.totalTokens).toBe(6);
});

test("spawn_subagent routes to a named agent (its mode + system apply)", async () => {
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "s1",
        toolName: "spawn_subagent",
        input: JSON.stringify({ prompt: "look at engine.ts", agent: "explore" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "c" },
      { type: "text-delta", id: "c", delta: "explored" },
      { type: "text-end", id: "c" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "p" },
      { type: "text-delta", id: "p", delta: "done" },
      { type: "text-end", id: "p" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  const systems: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      systems.push(JSON.stringify(options.prompt));
      return steps[call++] as never;
    },
  });

  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    agents: new Map([
      [
        "explore",
        {
          name: "explore",
          description: "read-only research",
          mode: "plan" as const,
          system: "EXPLORE-AGENT-MARKER",
        },
      ],
    ]),
  });

  await session.run("delegate to explore");

  // The child (second model call) ran with the named agent's system body and in
  // its declared plan mode (read-only), not the parent's execute mode.
  expect(systems[1]).toContain("EXPLORE-AGENT-MARKER");
  expect(systems[1]).toContain("MUST NOT modify"); // plan-mode marker
});

test("a plan-mode parent's subagents are coerced read-only (even if execute is requested)", async () => {
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "s1",
        toolName: "spawn_subagent",
        // Explicitly ask for execute — the plan-mode parent must override it.
        input: JSON.stringify({ prompt: "investigate", mode: "execute" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "c" },
      { type: "text-delta", id: "c", delta: "findings" },
      { type: "text-end", id: "c" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "p" },
      { type: "text-delta", id: "p", delta: "plan ready" },
      { type: "text-end", id: "p" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  const systems: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      systems.push(JSON.stringify(options.prompt));
      return steps[call++] as never;
    },
  });

  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "plan",
  });

  await session.run("plan a refactor");
  // The child (second model call) ran in plan mode despite requesting execute.
  expect(systems[1]).toContain("MUST NOT modify");
});

test("fork() gives a subagent a fresh context — no inherited history/usage/cost/store", async () => {
  // Regression for the resume+subagent leak: a resumed parent carries
  // initial*/store in its deps; a forked subagent must NOT inherit any of it.
  const dir = mkdtempSync(join(tmpdir(), "vibe-fork-"));
  const store = new SessionStore(dir);
  const model = new MockLanguageModelV2({
    doStream: async () =>
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "c" },
        { type: "text-delta", id: "c", delta: "child" },
        { type: "text-end", id: "c" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never,
  });
  const parent = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    store,
    // Simulate a resumed parent with prior history / usage / cost.
    initialUsage: { inputTokens: 100, outputTokens: 100 },
    initialCostUSD: 5,
    initialModelMessages: [{ role: "user", content: "old history" }],
  });

  const child = parent.fork({ bus: new EventBus(), depth: 1 });
  // The child starts clean — none of the parent's seeded totals carry over.
  expect(child.snapshot().usage.totalTokens).toBe(0);
  expect(child.costUSD).toBe(0);

  await child.run("do the subtask");
  // Only the child's own single step is counted (2 tokens), not 200 + 2.
  expect(child.snapshot().usage.totalTokens).toBe(2);
  // The child is ephemeral: it must not persist itself into the parent's store
  // (which would pollute /resume and hijack --continue).
  expect(await store.list()).toHaveLength(0);
});
