import { test, expect } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import type { UIEvent, ToolDefinition } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session, isReviewClean } from "./session.ts";

function mockRegistry(model: MockLanguageModelV2) {
  return new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
}
function stream(chunks: unknown[]) {
  return { stream: simulateReadableStream({ chunks: chunks as never[], initialDelayInMs: 0, chunkDelayInMs: 0 }) };
}
function textStep(delta: string) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]);
}
const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function orchestrationConfig() {
  const c = { ...defaultConfig() };
  c.orchestration = { enabled: true };
  return c;
}

test("spawn_tasks runs a dependency-ordered plan and returns a consolidated report", async () => {
  // parent: spawn_tasks([a, b<-a]) -> child a -> child b -> parent wrap.
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "spawn_tasks",
        input: JSON.stringify({
          tasks: [
            { id: "a", objective: "do task A", deps: [] },
            { id: "b", objective: "do task B", deps: ["a"] },
          ],
        }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    textStep("A is complete"), // child a
    textStep("B is complete"), // child b (runs after a)
    textStep("all orchestrated"), // parent wrap
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
    config: orchestrationConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  await session.run("orchestrate A then B");
  bus.close();
  await collector;

  const done = events.find((e) => e.type === "tool-call-finished" && e.toolName === "spawn_tasks");
  const out = done && done.type === "tool-call-finished" ? String(done.output) : "";
  expect(out).toContain("A is complete");
  expect(out).toContain("B is complete");
  expect(out).toContain("2 completed");
  // Both children ran (a then b) plus the parent's two steps.
  expect(call).toBe(4);
  // Orchestration status events were emitted for both tasks.
  const statuses = events.filter((e) => e.type === "orchestration-task");
  expect(statuses.some((e) => e.type === "orchestration-task" && e.taskId === "a" && e.status === "completed")).toBe(true);
  expect(statuses.some((e) => e.type === "orchestration-task" && e.taskId === "b" && e.status === "completed")).toBe(true);
});

test("spawn_tasks rejects an invalid plan (dependency cycle) without running anything", async () => {
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "spawn_tasks",
        input: JSON.stringify({
          tasks: [
            { id: "a", objective: "A", deps: ["b"] },
            { id: "b", objective: "B", deps: ["a"] },
          ],
        }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    textStep("acknowledged the error"),
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
    config: orchestrationConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  await session.run("submit a cyclic plan");
  bus.close();
  await collector;

  const done = events.find((e) => e.type === "tool-call-finished" && e.toolName === "spawn_tasks");
  expect(done && done.type === "tool-call-finished" && done.isError).toBe(true);
  expect(call).toBe(2); // only the parent's two steps; no children ran
});

test("spawn_tasks is only offered when orchestration is enabled", async () => {
  const toolNames: string[][] = [];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const tools = (options as { tools?: { name: string }[] }).tools ?? [];
      toolNames.push(tools.map((t) => t.name));
      return textStep("ok") as never;
    },
  });
  // Disabled (default): spawn_subagent present, spawn_tasks absent.
  const off = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  await off.run("hi");
  expect(toolNames[0]).toContain("spawn_subagent");
  expect(toolNames[0]).not.toContain("spawn_tasks");
});

test("isReviewClean requires the verdict on its own line, not a bare substring", () => {
  // Clean verdicts.
  expect(isReviewClean("REVIEW-CLEAN")).toBe(true);
  expect(isReviewClean("REVIEW-CLEAN — everything checks out")).toBe(true);
  expect(isReviewClean("Looks correct and complete.\nREVIEW-CLEAN")).toBe(true);
  expect(isReviewClean("   REVIEW-CLEAN\n")).toBe(true);
  // Adversarial rejections that MENTION the token must NOT read as clean (the old
  // substring test misread these and silently discarded the reviewer's issues).
  expect(isReviewClean("This is NOT REVIEW-CLEAN — src/foo.ts:10 missing null check")).toBe(false);
  expect(isReviewClean("this is not REVIEW-CLEAN")).toBe(false);
  expect(isReviewClean("The work is not REVIEW-CLEAN yet; fix path:line")).toBe(false);
  expect(isReviewClean("src/foo.ts:10 — problem")).toBe(false);
  expect(isReviewClean("")).toBe(false);
});

test("a verify task whose retry makes no changes is NOT falsely marked completed", async () => {
  // attempt 1 mutates (touch) → reviewer rejects → attempt 2 makes NO edits → the
  // prior rejected work is still on disk, so it must re-review and FAIL, not
  // short-circuit to "completed" on the non-mutating retry.
  const touchTool: ToolDefinition<Record<string, never>> = {
    name: "touch",
    description: "make a change",
    inputSchema: z.object({}),
    readOnly: false,
    concurrencySafe: false,
    async execute() {
      return { output: "touched" };
    },
  };
  const steps = [
    // 0: parent submits a single verify task.
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "p1",
        toolName: "spawn_tasks",
        input: JSON.stringify({ tasks: [{ id: "t", objective: "fix the bug", verify: true }] }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    // 1-2: attempt 1 child mutates then reports.
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "touch", input: "{}" },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    textStep("made the fix"),
    // 3: reviewer rejects (mentions the token in a negative sentence).
    textStep("This is NOT REVIEW-CLEAN — src/foo.ts:10 still broken"),
    // 4: attempt 2 makes NO edits (just analysis).
    textStep("On reflection it already looks correct; no edits needed"),
    // 5: reviewer rejects again.
    textStep("Still NOT REVIEW-CLEAN — src/foo.ts:10 unchanged"),
    // 6: parent wrap-up.
    textStep("done orchestrating"),
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
    config: orchestrationConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([touchTool]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  await session.run("fix it and verify");
  bus.close();
  await collector;

  const done = events.find((e) => e.type === "tool-call-finished" && e.toolName === "spawn_tasks");
  const out = done && done.type === "tool-call-finished" ? String(done.output) : "";
  // The task is reported FAILED (0 completed), not completed, and the review ran twice.
  expect(out).toContain("0 completed");
  expect(out).toContain("Verification still failing");
  expect(call).toBe(7); // parent + a1(2) + review + a2 + review + parent-wrap
});
