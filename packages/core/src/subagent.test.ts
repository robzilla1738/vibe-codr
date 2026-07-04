import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import type { ToolDefinition, UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";
import { SessionStore } from "./store.ts";
import { createLimiter } from "./limiter.ts";

function mockRegistry(model: MockLanguageModelV2) {
  return new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
}

import { createBlackboard } from "./blackboard.ts";

test("a named agent's tool allowlist restricts the child's tools", async () => {
  const readTool = {
    name: "fake_read",
    description: "read",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => ({ output: "ok" }),
  } as unknown as ToolDefinition;
  const writeTool = {
    name: "fake_write",
    description: "write",
    inputSchema: z.object({}),
    readOnly: false,
    concurrencySafe: true,
    execute: async () => ({ output: "ok" }),
  } as unknown as ToolDefinition;

  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "s1", toolName: "spawn_subagent", input: JSON.stringify({ prompt: "scout", agent: "scout" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "c" },
      { type: "text-delta", id: "c", delta: "scouted" },
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
  const toolNames: string[][] = [];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const tools = (options as { tools?: { name: string }[] }).tools ?? [];
      toolNames.push(tools.map((t) => t.name));
      return steps[call++] as never;
    },
  });
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([readTool, writeTool]),
    bus: new EventBus(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    agents: new Map([
      ["scout", { name: "scout", description: "read-only scout", mode: "execute" as const, tools: ["fake_read"] }],
    ]),
  });
  await session.run("delegate to the restricted scout");
  // Child call is index 1; its tools must be exactly the allowlist — not
  // fake_write, recall_memory, spawn_subagent, etc.
  expect(toolNames[1]).toEqual(["fake_read"]);
  // The parent (index 0) is unrestricted: it has the full set.
  expect(toolNames[0]).toContain("fake_write");
  expect(toolNames[0]).toContain("spawn_subagent");
});

test("a hung subagent is stopped by the wall-clock timeout and reported", async () => {
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "s1", toolName: "spawn_subagent", input: JSON.stringify({ prompt: "do slow work" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    // Child stream stalls long past the 50ms timeout (initialDelay 3s).
    {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "c" },
          { type: "text-delta", id: "c", delta: "still going" },
          { type: "text-end", id: "c" },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ] as never[],
        initialDelayInMs: 300, // > the 50ms timeout, so the guard fires first
        chunkDelayInMs: 0,
      }),
    },
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "p" },
      { type: "text-delta", id: "p", delta: "moving on" },
      { type: "text-end", id: "p" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  const config = { ...defaultConfig() };
  config.subagent = { ...config.subagent, timeoutMs: 50 };
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  await session.run("delegate slow work");
  bus.close();
  await collector;

  const toolDone = events.find(
    (e) => e.type === "tool-call-finished" && e.toolName === "spawn_subagent",
  );
  const out = toolDone && toolDone.type === "tool-call-finished" ? String(toolDone.output) : "";
  expect(out).toMatch(/timed out/i);
  expect(toolDone && toolDone.type === "tool-call-finished" && toolDone.isError).toBe(true);
});

test("post_note writes to the shared board and read_notes reads it back", async () => {
  // The agent posts a coordination note, then reads it back — exercising the
  // post_note/read_notes tools against the shared board (by reference).
  const board = createBlackboard();
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "p1", toolName: "post_note", input: JSON.stringify({ note: "claimed src/auth.ts" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "r1", toolName: "read_notes", input: JSON.stringify({}) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "p" },
      { type: "text-delta", id: "p", delta: "done" },
      { type: "text-end", id: "p" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    blackboard: board,
  });

  await session.run("coordinate via the board");
  bus.close();
  await collector;

  // The note landed on the shared board...
  expect(board.read().some((n) => n.text === "claimed src/auth.ts")).toBe(true);
  // ...and read_notes surfaced it (proving the agent saw the shared state).
  const notesRead = events.find(
    (e) => e.type === "tool-call-finished" && e.toolName === "read_notes",
  );
  const out = notesRead && notesRead.type === "tool-call-finished" ? String(notesRead.output) : "";
  expect(out).toContain("claimed src/auth.ts");
});

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

/** A single assistant text step. */
function textStep(delta: string) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]);
}

/** A single tool-call step. */
function toolStep(toolName: string, input: unknown) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: `tc_${Math.random().toString(36).slice(2, 8)}`, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]);
}

const OUTPUT_SCHEMA = {
  type: "object",
  required: ["status", "count"],
  properties: {
    status: { type: "string", enum: ["ok", "fail"] },
    count: { type: "integer" },
  },
};

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

  // The subagent's result is fed back to the parent as the tool output, with the
  // continuation handle appended so the model can follow up via continue_subagent.
  const toolDone = events.find(
    (e) => e.type === "tool-call-finished" && e.toolName === "spawn_subagent",
  );
  const spawnOut =
    toolDone && toolDone.type === "tool-call-finished" ? String(toolDone.output) : "";
  expect(spawnOut).toContain("child result");
  expect(spawnOut).toContain("continue_subagent");

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

test("a subagent's oversized answer is capped before it reaches the parent prompt", async () => {
  // A child's final answer lands verbatim in the PARENT's context. Like every
  // other context-producing tool it must be bounded, or a verbose/runaway child
  // floods the parent and can 400 the next turn. The UI event keeps the full text.
  const huge = "X".repeat(40_000); // > MAX_SUBAGENT_OUTPUT (32k)
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "s1",
        toolName: "spawn_subagent",
        input: JSON.stringify({ prompt: "produce a long report" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "c" },
      { type: "text-delta", id: "c", delta: huge },
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
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  await session.run("delegate a big report");
  bus.close();
  await collector;

  // The model-facing tool output is capped with an explicit marker.
  const toolDone = events.find(
    (e) => e.type === "tool-call-finished" && e.toolName === "spawn_subagent",
  );
  const output =
    toolDone && toolDone.type === "tool-call-finished" ? String(toolDone.output) : "";
  expect(output.length).toBeLessThan(huge.length);
  expect(output).toContain("truncated");

  // The UI event still carries the complete answer (nothing lost on screen).
  const finished = events.find((e) => e.type === "subagent-finished");
  expect(finished && finished.type === "subagent-finished" && finished.result).toBe(huge);
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
  expect(systems[1]).toContain("do NOT modify"); // plan-mode marker
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
  expect(systems[1]).toContain("do NOT modify");
});

test("a plan-mode parent rejects an execute-only named agent (no child runs)", async () => {
  // The roster hides execute agents while planning, but the model could still
  // name one. Coercing `test` (a writer) to plan would hand it a write-oriented
  // brief with no write tools — a wasted turn. It must be rejected up front.
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "s1",
        toolName: "spawn_subagent",
        input: JSON.stringify({ prompt: "add tests", agent: "test" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "p" },
      { type: "text-delta", id: "p", delta: "plan ready" },
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
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "plan",
    agents: new Map([
      ["test", { name: "test", description: "writes tests", mode: "execute" as const }],
      ["explore", { name: "explore", description: "read-only", mode: "plan" as const }],
    ]),
  });

  await session.run("plan some testing");
  bus.close();
  await collector;

  // The child never started — the spawn was rejected before forking.
  expect(events.find((e) => e.type === "subagent-started")).toBeUndefined();
  // The parent saw an error pointing at the read-only agent it CAN use.
  const toolDone = events.find(
    (e) => e.type === "tool-call-finished" && e.toolName === "spawn_subagent",
  );
  const output =
    toolDone && toolDone.type === "tool-call-finished" ? String(toolDone.output) : "";
  expect(output).toContain("execute mode");
  expect(output).toContain("explore");
  // Only the parent's own two steps ran (no child model call).
  expect(call).toBe(2);
});

test("a read-only subagent does NOT mark the parent turn as mutating", async () => {
  // spawn_subagent is read-only; an investigation child that touches nothing must
  // not flip the parent's didMutate (which would spuriously trigger auto-verify).
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "s1", toolName: "spawn_subagent", input: JSON.stringify({ prompt: "investigate" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "c" },
      { type: "text-delta", id: "c", delta: "looked, found nothing to change" },
      { type: "text-end", id: "c" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "p" },
      { type: "text-delta", id: "p", delta: "ok" },
      { type: "text-end", id: "p" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  await session.run("delegate a read-only look");
  expect(session.didMutate).toBe(false);
});

test("a subagent that mutates DOES mark the parent turn as mutating", async () => {
  // A child that calls a non-read-only tool propagates didMutate up to the parent
  // so auto-verify still runs — without the blanket spawn_subagent=mutated proxy.
  let mutations = 0;
  const writeTool = {
    name: "do_write",
    description: "pretend to write a file",
    inputSchema: z.object({}),
    readOnly: false,
    concurrencySafe: true,
    execute: async () => {
      mutations++;
      return { output: "wrote" };
    },
  } as unknown as ToolDefinition;
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "s1", toolName: "spawn_subagent", input: JSON.stringify({ prompt: "make a change" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    // child step 1: call the mutating tool
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "w1", toolName: "do_write", input: JSON.stringify({}) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    // child step 2: report
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "c" },
      { type: "text-delta", id: "c", delta: "done writing" },
      { type: "text-end", id: "c" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
    // parent wrap-up
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "p" },
      { type: "text-delta", id: "p", delta: "ok" },
      { type: "text-end", id: "p" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const session = new Session({
    config: { ...defaultConfig(), approvalMode: "auto" },
    registry: mockRegistry(model),
    toolset: new Toolset([writeTool]),
    bus: new EventBus(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  await session.run("delegate a mutating change");
  expect(mutations).toBe(1);
  expect(session.didMutate).toBe(true);
});

test("a fanning parent under a max:1 limiter with timeoutMs=0 completes (no hold-and-wait deadlock)", async () => {
  // The parent holds the ONE tree-global limiter slot for its whole turn — tool
  // window included. Its spawned child inherits the SAME limiter via fork() and
  // would queue on that slot: hold-and-wait. With subagent.timeoutMs=0 the
  // per-child wall-clock escape is disabled, so without suspendLimiterSlot handing
  // the parent's slot back for the child's span this deadlocks forever. The
  // test-side timeout makes a regression FAIL fast instead of hanging the suite.
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "s1", toolName: "spawn_subagent", input: JSON.stringify({ prompt: "child work" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "c" },
      { type: "text-delta", id: "c", delta: "child done" },
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
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });

  const config = { ...defaultConfig() };
  config.subagent = { ...config.subagent, timeoutMs: 0 };

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    // The ONE-slot tree-global limiter the parent and its forked child share.
    limiter: createLimiter({ max: 1, min: 1 }),
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("deadlocked: parent never completed under the max:1 limiter")),
      2_000,
    );
  });
  try {
    await Promise.race([session.run("delegate under a one-slot limiter"), timeout]);
  } finally {
    clearTimeout(timer);
  }
  bus.close();
  await collector;

  // The child ran, reported back, and the parent finished its own turn — proving
  // the slot was released for the child then re-acquired for the parent's wrap-up.
  const finished = events.find((e) => e.type === "subagent-finished");
  expect(finished && finished.type === "subagent-finished" && finished.result).toBe("child done");
  const text = events
    .filter((e): e is Extract<UIEvent, { type: "assistant-text-delta" }> => e.type === "assistant-text-delta")
    .map((e) => e.delta)
    .join("");
  expect(text).toBe("parent done");
  expect(call).toBe(3); // parent spawn, child, parent wrap-up all ran
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

test("continue_subagent resumes a retained child with its prior context", async () => {
  // Turn 1 spawns a child that learns a fact; turn 2 continues THAT child, which
  // must still see its first-run conversation (proving continuation keeps context).
  const ordered = [
    toolStep("spawn_subagent", { prompt: "CHILDTASK remember the secret is 42" }), // 0 parent
    textStep("Understood. The secret is 42."), // 1 child (first run)
    textStep("spawned the child"), // 2 parent wrap
    undefined, // 3 handled dynamically (continue with the captured id)
    textStep("The secret is 42."), // 4 continued child
    textStep("recalled from the child"), // 5 parent wrap
  ];
  let call = 0;
  let childId = "";
  let continuedPrompt = "";
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const i = call++;
      if (i === 3) return toolStep("continue_subagent", { id: childId, message: "CHILDFOLLOWUP what was the secret?" }) as never;
      if (i === 4) continuedPrompt = JSON.stringify(options.prompt);
      return ordered[i] as never;
    },
  });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) {
      events.push(e);
      if (e.type === "subagent-started" && !childId) childId = e.subagentId;
    }
  })();

  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  await session.run("spawn a child that remembers something");
  await new Promise((r) => setTimeout(r, 10)); // let the collector capture childId
  expect(childId).not.toBe("");
  await session.run("now continue that child");
  bus.close();
  await collector;

  // The continued child's prompt carried its FIRST-run conversation (the fact) as
  // well as the new follow-up — the whole point of continuation over re-spawning.
  expect(continuedPrompt).toContain("the secret is 42");
  expect(continuedPrompt).toContain("CHILDFOLLOWUP");
  // The continue tool returned the child's answer with the follow-up handle.
  const contDone = events.find((e) => e.type === "tool-call-finished" && e.toolName === "continue_subagent");
  const out = contDone && contDone.type === "tool-call-finished" ? String(contDone.output) : "";
  expect(out).toContain("The secret is 42.");
  expect(out).toContain("continue_subagent");
  expect(call).toBe(6); // spawn, child, wrap, continue, continued-child, wrap
});

test("continue_subagent honestly refuses a child whose working directory was removed", async () => {
  // A subagent that ran inside a directory later torn down (the worktree-cleanup
  // case) must NOT be resumed into a deleted cwd (ENOENT). continue_subagent
  // evicts it and returns an honest expired error, and the child never re-runs.
  const dir = mkdtempSync(join(tmpdir(), "vibe-wt-"));
  const ordered = [
    toolStep("spawn_subagent", { prompt: "scout the tree" }), // 0 parent spawn
    textStep("scouted"), // 1 child (first run)
    textStep("spawned the child"), // 2 parent wrap
    undefined, // 3 continue (captured id, injected below)
    textStep("acknowledged the expiry"), // 4 parent wrap after the error
  ];
  let call = 0;
  let childId = "";
  const model = new MockLanguageModelV2({
    doStream: async () => {
      const i = call++;
      if (i === 3) return toolStep("continue_subagent", { id: childId, message: "keep going" }) as never;
      return ordered[i] as never;
    },
  });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) {
      events.push(e);
      if (e.type === "subagent-started" && !childId) childId = e.subagentId;
    }
  })();

  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: dir,
    model: "mock/test",
    mode: "execute",
  });

  await session.run("spawn a scout in the worktree");
  await new Promise((r) => setTimeout(r, 10));
  expect(childId).not.toBe("");

  // Simulate the worktree teardown: the child's working directory is gone.
  rmSync(dir, { recursive: true, force: true });

  await session.run("now continue that scout");
  bus.close();
  await collector;

  // The continuation was refused honestly (no ENOENT crash, no fabricated resume).
  const done = events.find((e) => e.type === "tool-call-finished" && e.toolName === "continue_subagent");
  const out = done && done.type === "tool-call-finished" ? String(done.output) : "";
  expect(done && done.type === "tool-call-finished" && done.isError).toBe(true);
  expect(out).toMatch(/no longer be resumed|cleaned up/i);
  // The child never re-ran — only the spawn's own start event exists.
  expect(events.filter((e) => e.type === "subagent-started").length).toBe(1);
  expect(call).toBe(5); // spawn, child, wrap, continue(error), wrap
});

test("an execute child continued during plan is coerced read-only, then restored to execute when continued during execute", async () => {
  // Regression: continue_subagent coerced an execute-native retained child to
  // plan while the parent planned but NEVER restored it — so after the parent
  // returned to execute the continued child stayed read-only forever. The
  // pre-coercion mode is remembered and restored on the next execute-time
  // continuation. Observed via the child's system prompt: plan mode carries the
  // "do NOT modify" marker, execute mode does not.
  let call = 0;
  let childId = "";
  const systems: Record<number, string> = {};
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const i = call++;
      systems[i] = JSON.stringify(options.prompt);
      // Parent continuation turns (3 = during plan, 6 = during execute).
      if (i === 3 || i === 6) {
        return toolStep("continue_subagent", { id: childId, message: "keep going" }) as never;
      }
      // 0 parent spawn; 1 child first run; 2 parent wrap; 4 continued child
      // (plan); 5 parent wrap; 7 continued child (execute); 8 parent wrap.
      if (i === 0) return toolStep("spawn_subagent", { prompt: "scout the tree" }) as never;
      return textStep("ok") as never;
    },
  });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) {
      events.push(e);
      if (e.type === "subagent-started" && !childId) childId = e.subagentId;
    }
  })();

  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  // Turn 1 (execute): spawn an execute-native child.
  await session.run("spawn an execute child");
  await new Promise((r) => setTimeout(r, 10));
  expect(childId).not.toBe("");

  // Turn 2 (plan): continue it — the child is coerced to plan (read-only).
  session.setMode("plan");
  await session.run("continue it while planning");

  // Turn 3 (execute): continue it again — the child is restored to execute.
  session.setMode("execute");
  await session.run("continue it while executing");
  bus.close();
  await collector;

  // The child's FIRST run (call 1) was execute — no read-only marker.
  expect(systems[1]).not.toContain("do NOT modify");
  // Continued DURING PLAN (call 4): coerced read-only.
  expect(systems[4]).toContain("do NOT modify");
  // Continued DURING EXECUTE (call 7): restored to execute — marker gone.
  expect(systems[7]).not.toContain("do NOT modify");
});

test("continue_subagent on an unknown id returns an error (no child runs)", async () => {
  const ordered = [
    toolStep("continue_subagent", { id: "sub_nonexistent", message: "keep going" }), // 0 parent
    textStep("acknowledged"), // 1 parent wrap
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => ordered[call++] as never });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  await session.run("continue a child that doesn't exist");
  bus.close();
  await collector;

  const done = events.find((e) => e.type === "tool-call-finished" && e.toolName === "continue_subagent");
  const out = done && done.type === "tool-call-finished" ? String(done.output) : "";
  expect(done && done.type === "tool-call-finished" && done.isError).toBe(true);
  expect(out).toContain("sub_nonexistent");
  expect(events.find((e) => e.type === "subagent-started")).toBeUndefined(); // never forked
  expect(call).toBe(2);
});

test("structured output: a valid-first-try JSON answer is returned verbatim", async () => {
  const ordered = [
    toolStep("spawn_subagent", { prompt: "report status", outputSchema: OUTPUT_SCHEMA }), // 0
    textStep('{"status":"ok","count":3}'), // 1 child — valid immediately
    textStep("done"), // 2 parent wrap
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => ordered[call++] as never });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  await session.run("get me structured status");
  bus.close();
  await collector;

  const done = events.find((e) => e.type === "tool-call-finished" && e.toolName === "spawn_subagent");
  const out = done && done.type === "tool-call-finished" ? String(done.output) : "";
  expect(done && done.type === "tool-call-finished" && done.isError).toBeFalsy();
  // Pristine JSON — no continue-handle suffix that would break a machine consumer.
  expect(JSON.parse(out)).toEqual({ status: "ok", count: 3 });
  expect(out).not.toContain("continue_subagent");
  expect(call).toBe(3); // no retry needed
});

test("structured output: an invalid answer is retried, then accepted", async () => {
  const ordered = [
    toolStep("spawn_subagent", { prompt: "report status", outputSchema: OUTPUT_SCHEMA }), // 0
    textStep("I could not format that as JSON, sorry."), // 1 child — invalid (no JSON)
    textStep('{"status":"ok","count":7}'), // 2 child re-run — valid
    textStep("done"), // 3 parent wrap
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => ordered[call++] as never });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  const session = new Session({
    config: defaultConfig(), // structuredMaxAttempts defaults to 2
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  await session.run("get me structured status, retrying if needed");
  bus.close();
  await collector;

  const done = events.find((e) => e.type === "tool-call-finished" && e.toolName === "spawn_subagent");
  const out = done && done.type === "tool-call-finished" ? String(done.output) : "";
  expect(JSON.parse(out)).toEqual({ status: "ok", count: 7 });
  expect(call).toBe(4); // spawn, invalid child, valid retry, parent wrap
});

test("structured output: exhausted retries return an error with the raw text, never a fabricated object", async () => {
  const ordered = [
    toolStep("spawn_subagent", { prompt: "report status", outputSchema: OUTPUT_SCHEMA }), // 0
    textStep("attempt one: still not JSON"), // 1 invalid
    textStep("attempt two: RAWMARKER still not JSON"), // 2 invalid (last attempt)
    textStep("done"), // 3 parent wrap
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => ordered[call++] as never });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  const session = new Session({
    config: defaultConfig(), // structuredMaxAttempts = 2
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  await session.run("get me structured status but it will fail");
  bus.close();
  await collector;

  const done = events.find((e) => e.type === "tool-call-finished" && e.toolName === "spawn_subagent");
  const out = done && done.type === "tool-call-finished" ? String(done.output) : "";
  expect(done && done.type === "tool-call-finished" && done.isError).toBe(true);
  expect(out).toContain("did not match"); // honest failure
  expect(out).toContain("RAWMARKER"); // carries the raw text, not a fabricated object
  expect(() => JSON.parse(out)).toThrow(); // it is NOT a JSON object
  expect(call).toBe(4); // spawn + 2 child attempts + parent wrap
});

test("a detached spawn returns immediately, then surfaces + is collectable next turn", async () => {
  let bgId = "";
  let turn2Prompt = "";
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const p = JSON.stringify(options.prompt ?? "");
      // turn 2 step 2: the check_task result is now in context.
      if (p.includes("Background spawn")) return textStep("collected") as never;
      // turn 2 step 1: the user asked to check; call check_task with the captured id.
      if (p.includes("CHECKNOW")) {
        turn2Prompt = p;
        return toolStep("check_task", { id: bgId }) as never;
      }
      // turn 1 step 2: the detach result ("…in the background…") is in context.
      if (p.includes("in the background")) return textStep("kept working") as never;
      // the background child itself.
      if (p.includes("BGWORK")) return textStep("BG-RESULT-42") as never;
      // turn 1 step 1: spawn a detached child.
      return toolStep("spawn_subagent", { prompt: "do BGWORK now", detach: true }) as never;
    },
  });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) {
      events.push(e);
      if (e.type === "subagent-started" && !bgId) bgId = e.subagentId;
    }
  })();

  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    interactive: true, // detach only runs in the background when interactive
  });

  await session.run("TURN1: spawn a background task");
  await new Promise((r) => setTimeout(r, 10));
  expect(bgId).not.toBe("");
  // The spawn returned a HANDLE immediately, not the child's result.
  const spawnDone = events.find((e) => e.type === "tool-call-finished" && e.toolName === "spawn_subagent");
  const spawnOut = spawnDone && spawnDone.type === "tool-call-finished" ? String(spawnDone.output) : "";
  expect(spawnOut).toContain("background");
  expect(spawnOut).toContain("check_task");
  expect(spawnOut).not.toContain("BG-RESULT-42"); // result is NOT inlined

  // Let the background child finish, then confirm it settled in the registry.
  await session.childRegistry?.awaitAllDetached(2_000);
  await new Promise((r) => setTimeout(r, 10));
  const rec = session.childRegistry?.getDetached(bgId);
  expect(rec?.status).toBe("completed");
  expect(rec?.report).toContain("BG-RESULT-42");
  const finished = events.find((e) => e.type === "subagent-finished");
  expect(finished && finished.type === "subagent-finished" && finished.result).toBe("BG-RESULT-42");

  await session.run("TURN2: CHECKNOW what happened");
  bus.close();
  await collector;

  // The finished background child was surfaced into turn 2's workspace state...
  expect(turn2Prompt).toContain("BACKGROUND SUBAGENTS FINISHED");
  expect(turn2Prompt).toContain(bgId);
  // ...and check_task returned its report.
  const checkDone = events.find((e) => e.type === "tool-call-finished" && e.toolName === "check_task");
  const checkOut = checkDone && checkDone.type === "tool-call-finished" ? String(checkDone.output) : "";
  expect(checkOut).toContain("BG-RESULT-42");
  expect(checkOut).toContain("completed");
});

test("headless coerces detach to synchronous with a one-time notice", async () => {
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const p = JSON.stringify(options.prompt ?? "");
      // parent step 2: the (synchronous) child result is already in context.
      if (p.includes("SYNC-RESULT")) return textStep("wrapped up") as never;
      // the child, run synchronously despite detach:true.
      if (p.includes("SYNCWORK")) return textStep("SYNC-RESULT") as never;
      // parent step 1: request a detached spawn.
      return toolStep("spawn_subagent", { prompt: "do SYNCWORK", detach: true }) as never;
    },
  });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
    interactive: false, // headless — detach must be coerced to synchronous
  });
  await session.run("please do a background task");
  bus.close();
  await collector;

  // The spawn ran synchronously: its tool result IS the child's answer (not a handle).
  const spawnDone = events.find((e) => e.type === "tool-call-finished" && e.toolName === "spawn_subagent");
  const out = spawnDone && spawnDone.type === "tool-call-finished" ? String(spawnDone.output) : "";
  expect(out).toContain("SYNC-RESULT");
  expect(out).not.toContain("in the background");
  // A one-time notice explained the coercion.
  const notice = events.find((e) => e.type === "notice" && /interactive/i.test(e.message));
  expect(notice).toBeDefined();
  // No detached child was tracked.
  expect(session.childRegistry?.runningDetachedCount() ?? 0).toBe(0);
});

test("a mid-turn mode flip cannot un-coerce a child spawned later in the same plan turn", async () => {
  // Regression: #forkChild read the LIVE mode, so a user flipping plan→execute
  // while a plan turn was in flight made a later spawn in that SAME turn fork a
  // writable child — whose mutations also bypassed the plan turn's skipped gate.
  const writeTool = {
    name: "fake_write",
    description: "write",
    inputSchema: z.object({}),
    readOnly: false,
    concurrencySafe: true,
    execute: async () => ({ output: "ok" }),
  } as unknown as ToolDefinition;
  let flip: (() => void) | undefined;
  const flipTool = {
    name: "flip_mode",
    description: "test stub: simulates the user switching to execute mid-turn",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => {
      flip?.();
      return { output: "flipped" };
    },
  } as unknown as ToolDefinition;

  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "f1", toolName: "flip_mode", input: "{}" },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "s1", toolName: "spawn_subagent", input: JSON.stringify({ prompt: "scout" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "c" },
      { type: "text-delta", id: "c", delta: "scouted" },
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
  const toolNames: string[][] = [];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const tools = (options as { tools?: { name: string }[] }).tools ?? [];
      toolNames.push(tools.map((t) => t.name));
      return steps[call++] as never;
    },
  });
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([writeTool, flipTool]),
    bus: new EventBus(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "plan",
  });
  flip = () => session.setMode("execute");
  await session.run("plan something, flipping mid-turn");

  // The flip really happened before the spawn…
  expect(session.mode).toBe("execute");
  // …but the child (3rd model call) still forked READ-ONLY: no mutating tools.
  expect(toolNames[2]).not.toContain("fake_write");
});
