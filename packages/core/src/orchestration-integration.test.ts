import { test, expect, afterAll } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIEvent, ToolDefinition } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session, isReviewClean } from "./session.ts";
import { Engine } from "./engine.ts";
import { loadCompletedTasks } from "./build/journal.ts";

// A fresh cwd per session so the orchestration journal (now written under
// `.vibe/orchestration/` on every task settle) never lands in the real repo or
// bleeds a stale seed across tests.
const tmpDirs: string[] = [];
function tmpCwd(): string {
  const d = mkdtempSync(join(tmpdir(), "vibe-orch-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

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
    cwd: tmpCwd(),
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
    cwd: tmpCwd(),
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
  // Enabled (the default): both delegation tools are offered.
  const on = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: tmpCwd(),
    model: "mock/test",
    mode: "execute",
  });
  await on.run("hi");
  expect(toolNames[0]).toContain("spawn_subagent");
  expect(toolNames[0]).toContain("spawn_tasks");

  // Explicitly disabled: spawn_subagent stays, spawn_tasks is hidden.
  const offConfig = defaultConfig();
  offConfig.orchestration = { enabled: false };
  const off = new Session({
    config: offConfig,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: tmpCwd(),
    model: "mock/test",
    mode: "execute",
  });
  await off.run("hi");
  expect(toolNames[1]).toContain("spawn_subagent");
  expect(toolNames[1]).not.toContain("spawn_tasks");
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
    cwd: tmpCwd(),
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

test("a detached spawn_tasks batch runs in the background, journals, and honors the spawn ceiling", async () => {
  // A 2-task plan detached with a tree ceiling of ONE subagent: exactly one task
  // forks a child and completes; the other hits the spawn ceiling and fails. The
  // background batch still journals both tasks and is collectable via check_task.
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const p = JSON.stringify(options.prompt ?? "");
      // parent step 2: the detach result ("…in the background…") is now in context.
      if (p.includes("in the background")) return textStep("kept working") as never;
      if (p.includes("TASKA")) return textStep("A-DONE") as never;
      if (p.includes("TASKB")) return textStep("B-DONE") as never;
      // parent step 1: submit a detached 2-task plan.
      return stream([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "t1",
          toolName: "spawn_tasks",
          input: JSON.stringify({
            tasks: [
              { id: "a", objective: "do TASKA" },
              { id: "b", objective: "do TASKB" },
            ],
            detach: true,
          }),
        },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ]) as never;
    },
  });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  const cwd = tmpCwd();
  const config = orchestrationConfig();
  config.subagent = { ...config.subagent, maxTotal: 1 }; // ceiling of one subagent
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd,
    model: "mock/test",
    mode: "execute",
    interactive: true, // detach only backgrounds when interactive
  });

  await session.run("run a background plan");
  // Return was immediate — pull the batch id out of the detach handle message.
  const spawnDone = events.find((e) => e.type === "tool-call-finished" && e.toolName === "spawn_tasks");
  const spawnOut = spawnDone && spawnDone.type === "tool-call-finished" ? String(spawnDone.output) : "";
  expect(spawnOut).toContain("in the background");
  const batchId = /check_task\("([^"]+)"\)/.exec(spawnOut)?.[1] ?? "";
  expect(batchId).not.toBe("");

  // Let the background batch settle.
  await session.childRegistry?.awaitAllDetached(3_000);
  await new Promise((r) => setTimeout(r, 10));
  bus.close();
  await collector;

  // Exactly ONE child was forked (the ceiling of one), so one task completed and
  // the other failed on the budget.
  expect(events.filter((e) => e.type === "subagent-started").length).toBe(1);
  const rec = session.childRegistry?.getDetached(batchId);
  expect(rec?.status).toBe("completed"); // the batch promise settled
  expect(rec?.report).toContain("budget exhausted"); // the ceiling-blocked task
  expect(rec?.report).toContain("1 completed");

  // The batch journaled its tasks: exactly one completed task is recoverable.
  const journaled = loadCompletedTasks(cwd, session.id);
  expect(journaled.length).toBe(1);
});

test("engine finalize aborts an outstanding detached subagent", async () => {
  const cwd = tmpCwd();
  // A stream that opens then blocks forever — until the child's abort signal
  // fires, when it errors the stream so streamText unwinds. This guarantees the
  // child is still running at finalize AND that finalize's abort reaps it promptly.
  const hangStream = (signal: AbortSignal | undefined) => ({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        signal?.addEventListener(
          "abort",
          () => {
            try {
              controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
            } catch {
              /* already closed */
            }
          },
          { once: true },
        );
      },
    }),
  });
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const p = JSON.stringify(options.prompt ?? "");
      // Parent step 2 echoes the child's HANGWORK prompt in the spawn tool-call, so
      // match the parent-only "in the background" marker (the detach result) FIRST.
      if (p.includes("in the background")) return textStep("spawned") as never; // parent step 2
      if (p.includes("HANGWORK")) return hangStream(options.abortSignal) as never; // background child hangs until aborted
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "s1", toolName: "spawn_subagent", input: JSON.stringify({ prompt: "do HANGWORK now", detach: true }) },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ]) as never;
    },
  });

  const config = orchestrationConfig();
  config.model = "mock/test";
  config.build = { ...config.build, enabled: false }; // no recon/gate noise
  config.memory = { ...config.memory, proactiveRecall: false, sessionDigest: false };
  config.subagent = { ...config.subagent, timeoutMs: 0 }; // no wall-clock — finalize is the reaper

  const engine = new Engine({ config, cwd, registry: mockRegistry(model), interactive: true });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const sub = engine.events();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  engine.send({ type: "submit-prompt", text: "spawn a hanging background subagent" });
  await engine.whenIdle(); // the foreground turn is done; the detached child still hangs
  expect(events.some((e) => e.type === "subagent-started")).toBe(true);
  expect(events.some((e) => e.type === "subagent-finished")).toBe(false); // still running

  await engine.finalize(); // must abort + await the outstanding detached child
  await collector;

  // The hanging detached child was aborted and settled as interrupted (never
  // producing its would-be output).
  const finished = events.find((e) => e.type === "subagent-finished");
  expect(finished && finished.type === "subagent-finished" && /interrupt/i.test(finished.result)).toBe(true);
}, 15_000);
