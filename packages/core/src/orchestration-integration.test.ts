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
import { loadCompletedTasks, planIdentity } from "./build/journal.ts";

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

test("the journal plan stamp includes behavior-bearing fields (verify-pass regression)", async () => {
  // The spawn_tasks call site must hash files/verify/check/tier into the plan
  // identity — a stamp computed over id/objective/deps only would let a re-plan
  // that flips one of those fields inherit this run's completions.
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "spawn_tasks",
        input: JSON.stringify({
          tasks: [{ id: "a", objective: "do task A", deps: [], files: ["fa.txt"] }],
        }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    textStep("A is complete"), // child a
    textStep("all orchestrated"), // parent wrap
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const cwd = tmpCwd();
  const session = new Session({
    config: orchestrationConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("orchestrate A");

  const full = planIdentity([{ id: "a", objective: "do task A", deps: [], files: ["fa.txt"] }]);
  const stripped = planIdentity([{ id: "a", objective: "do task A", deps: [] }]);
  expect(full).not.toBe(stripped);
  // The journal event carries the FULL-field stamp: seeding under it works …
  expect(loadCompletedTasks(cwd, session.id, full).length).toBe(1);
  // … and a plan differing only in a behavior-bearing field seeds nothing.
  expect(loadCompletedTasks(cwd, session.id, stripped).length).toBe(0);
});

test("the journal plan stamp hashes worktree/hard/agent/outputSchema (BUG-002 regression)", async () => {
  // BUG-002 was a regression where the spawn_tasks call site hashed only
  // 7 fields while planIdentity() hashed 11, so a re-plan flipping any of
  // worktree/hard/agent/outputSchema reused the prior run's stamp and seeded
  // stale completions. This test asserts the stamp honors all four by running
  // each one through the spawn_tasks execute path and comparing the journal
  // stamp against a stripped form that differs ONLY in that field.
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "spawn_tasks",
        input: JSON.stringify({
          tasks: [{ id: "a", objective: "do task A", deps: [] }],
        }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    textStep("A is complete"),
    textStep("all orchestrated"),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const cwd = tmpCwd();
  const session = new Session({
    config: orchestrationConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("orchestrate A");

  // Baseline spec the run journaled under.
  const base = { id: "a", objective: "do task A", deps: [] as string[] };
  // One spec per behavior-bearing field the call site previously dropped —
  // each differs ONLY in that field, so a stamp that ignores it collides.
  const flips: ReadonlyArray<Parameters<typeof planIdentity>[0][number]> = [
    { ...base, worktree: true },
    { ...base, hard: true },
    { ...base, agent: "review" },
    { ...base, outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } },
  ];
  const stampedEveryTime = flips.every((spec) => loadCompletedTasks(cwd, session.id, planIdentity([spec])).length === 0);
  expect(stampedEveryTime).toBe(true);
  // Sanity: the baseline (no extra field) DOES seed this run's completion.
  expect(loadCompletedTasks(cwd, session.id, planIdentity([base])).length).toBe(1);
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

test("engine finalize terminates within a wall-clock bound even when a detached child wedges", async () => {
  // The finalize() timeout fix: when a background child's settle promise never
  // resolves (an abort was already signaled but the SDK ignored it), finalize
  // MUST still return — graceful exit can't be blocked forever by a wedged child.
  // The 5_000ms bound is generous enough for real unwind but caps the wait.
  const cwd = tmpCwd();
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const p = JSON.stringify(options.prompt ?? "");
      if (p.includes("in the background")) return textStep("spawned") as never;
      if (p.includes("WEDGEWORK")) return wedgeStream() as never; // hangs forever, even on abort
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "s1", toolName: "spawn_subagent", input: JSON.stringify({ prompt: "do WEDGEWORK now", detach: true }) },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ]) as never;
    },
  });

  const config = orchestrationConfig();
  config.model = "mock/test";
  config.build = { ...config.build, enabled: false };
  config.memory = { ...config.memory, proactiveRecall: false, sessionDigest: false };
  config.subagent = { ...config.subagent, timeoutMs: 0 };

  const engine = new Engine({ config, cwd, registry: mockRegistry(model), interactive: true });
  await engine.bootstrap();
  const sub = engine.events();
  const collector = (async () => {
    for await (const _e of sub) { /* drain */ }
  })();

  engine.send({ type: "submit-prompt", text: "spawn a wedged background subagent" });
  await engine.whenIdle();
  // The detached child is wedged — finalize must bound itself and return.
  const start = Date.now();
  await engine.finalize();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(15_000); // well under forever; 5s bound + teardown slack
  void collector;
}, 20_000);

// A stream that opens then blocks until aborted — used to pin a detached child
// in the "running" state across a turn boundary.
function hangStream(signal: AbortSignal | undefined) {
  return {
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
  };
}

// A stream that opens then IGNORES its abort signal — the SDK never unwinds, so
// the child's settle promise never resolves (the genuine wedged-child case the
// finalize timeout must bound). Used by the engine-finalize-wedge test.
function wedgeStream() {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        // Deliberately no abort listener — the stream hangs forever even after
        // the engine aborts the session.
      },
    }),
  };
}

// The read_notes RESULT — the only clean observable of the board's live state.
// (Its whole-prompt text is contaminated: the note string also appears in the
// post_note tool-call kept in conversation history, cleared or not.)
function readNotesOutput(events: UIEvent[]): string {
  const e = events.find((ev) => ev.type === "tool-call-finished" && ev.toolName === "read_notes");
  return e && e.type === "tool-call-finished" ? String(e.output) : "";
}

test("submit-prompt does NOT clear the blackboard while a detached child is still running", async () => {
  // Invariant: a DETACHED batch outlives the turn that spawned it and keeps
  // posting claims/decisions across turn boundaries — clearing the shared board
  // on the next submit-prompt would yank posted state out from under the live
  // fan-out. The lead posts a decision + spawns a hanging detached child in turn
  // 1; on turn 2's submit-prompt the note MUST survive (read_notes still sees it).
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const p = JSON.stringify(options.prompt ?? "");
      // The hanging background child (its own prompt has HANGWORK but not the
      // parent-only detach marker).
      if (p.includes("HANGWORK") && !p.includes("in the background")) {
        return hangStream(options.abortSignal) as never;
      }
      if (p.includes("MARKER2_AGAIN")) {
        // Turn 2 step 2: the read_notes tool-result is now in context (matched on
        // the JSON tool key, which — unlike the note text — can't leak from history).
        if (p.includes('"toolName":"read_notes"')) return textStep("turn2 done") as never;
        // Turn 2 step 1: read the board.
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "r1", toolName: "read_notes", input: "{}" },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ]) as never;
      }
      // Turn 1 step 2: post + spawn already ran (detach result in context).
      if (p.includes("in the background")) return textStep("turn1 done") as never;
      // Turn 1 step 1: post a decision, then spawn a hanging detached child.
      return stream([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "n1",
          toolName: "post_note",
          input: JSON.stringify({ note: "BOARD_DECISION_XYZ", kind: "decision" }),
        },
        {
          type: "tool-call",
          toolCallId: "s1",
          toolName: "spawn_subagent",
          input: JSON.stringify({ prompt: "do HANGWORK now", detach: true }),
        },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ]) as never;
    },
  });

  const cwd = tmpCwd();
  const config = orchestrationConfig();
  config.model = "mock/test";
  config.build = { ...config.build, enabled: false };
  config.memory = { ...config.memory, proactiveRecall: false, sessionDigest: false };
  config.subagent = { ...config.subagent, timeoutMs: 0 };
  const engine = new Engine({ config, cwd, registry: mockRegistry(model), interactive: true });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();

  engine.send({ type: "submit-prompt", text: "MARKER1 post then spawn" });
  await engine.whenIdle(); // turn 1 done; the detached child still hangs (running)
  engine.send({ type: "submit-prompt", text: "MARKER2_AGAIN read the board" });
  await engine.whenIdle();

  // read_notes still returned the note → the board was NOT cleared while the
  // detached child was running.
  expect(readNotesOutput(events)).toContain("BOARD_DECISION_XYZ");

  await engine.finalize();
  await collector;
}, 15_000);

test("submit-prompt clears the blackboard when no detached child is running", async () => {
  // The other half of the invariant: with nothing detached in flight the clear
  // still fires, so a stale note from an earlier turn can't leak into a later,
  // unrelated fan-out.
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const p = JSON.stringify(options.prompt ?? "");
      if (p.includes("MARKER2_AGAIN")) {
        if (p.includes('"toolName":"read_notes"')) return textStep("turn2 done") as never;
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "r1", toolName: "read_notes", input: "{}" },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ]) as never;
      }
      // Turn 1 step 2: the post result is in context.
      if (p.includes("Posted to the shared board")) return textStep("turn1 done") as never;
      // Turn 1 step 1: post a decision (no spawn — nothing detached).
      return stream([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "n1",
          toolName: "post_note",
          input: JSON.stringify({ note: "BOARD_DECISION_XYZ", kind: "decision" }),
        },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ]) as never;
    },
  });

  const cwd = tmpCwd();
  const config = orchestrationConfig();
  config.model = "mock/test";
  config.build = { ...config.build, enabled: false };
  config.memory = { ...config.memory, proactiveRecall: false, sessionDigest: false };
  const engine = new Engine({ config, cwd, registry: mockRegistry(model), interactive: true });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();

  engine.send({ type: "submit-prompt", text: "MARKER1 post a note" });
  await engine.whenIdle();
  engine.send({ type: "submit-prompt", text: "MARKER2_AGAIN read the board" });
  await engine.whenIdle();

  // read_notes came back empty → the board WAS cleared on the second submit-prompt.
  const out = readNotesOutput(events);
  expect(out).toContain("No shared notes yet");
  expect(out).not.toContain("BOARD_DECISION_XYZ");

  await engine.finalize();
  await collector;
}, 15_000);

test("a submit-prompt racing a not-yet-registered detached spawn does not wipe the board", async () => {
  // The timing window the detached-count guard alone missed: the clear used to
  // fire eagerly in send(), at ENQUEUE time. A prompt submitted while turn 1 is
  // still mid-flight — after it posted a decision but BEFORE its detached spawn
  // registered — found runningDetachedCount() === 0 and wiped the decision the
  // detached batch was about to kick off with. The clear now runs when the
  // queued prompt's turn STARTS (FIFO ⇒ turn 1 is done and its batch is
  // registered by then), so the decision must survive into turn 2's read.
  let engine!: Engine;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const p = JSON.stringify(options.prompt ?? "");
      // The hanging background child (its own prompt has HANGWORK but not the
      // parent-only detach marker).
      if (p.includes("HANGWORK") && !p.includes("in the background")) {
        return hangStream(options.abortSignal) as never;
      }
      if (p.includes("MARKER2_RACE")) {
        // Turn 2 step 2: the read_notes tool-result is in context.
        if (p.includes('"toolName":"read_notes"')) return textStep("turn2 done") as never;
        // Turn 2 step 1: read the board.
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "r1", toolName: "read_notes", input: "{}" },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ]) as never;
      }
      // Turn 1 step 3: the detach handle is in context — wrap up.
      if (p.includes("in the background")) return textStep("turn1 done") as never;
      // Turn 1 step 2: the decision is posted, the detached spawn hasn't run yet
      // — inject the racing prompt in EXACTLY this window, then spawn.
      if (p.includes("Posted to the shared board")) {
        engine.send({ type: "submit-prompt", text: "MARKER2_RACE read the board" });
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "s1",
            toolName: "spawn_subagent",
            input: JSON.stringify({ prompt: "do HANGWORK now", detach: true }),
          },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ]) as never;
      }
      // Turn 1 step 1: post the decision the batch depends on.
      return stream([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "n1",
          toolName: "post_note",
          input: JSON.stringify({ note: "BOARD_DECISION_RACE", kind: "decision" }),
        },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ]) as never;
    },
  });

  const cwd = tmpCwd();
  const config = orchestrationConfig();
  config.model = "mock/test";
  config.build = { ...config.build, enabled: false };
  config.memory = { ...config.memory, proactiveRecall: false, sessionDigest: false };
  config.subagent = { ...config.subagent, timeoutMs: 0 };
  engine = new Engine({ config, cwd, registry: mockRegistry(model), interactive: true });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();

  engine.send({ type: "submit-prompt", text: "MARKER1 post then spawn (prompt 2 injected mid-turn)" });
  await engine.whenIdle(); // drains BOTH turns (the race prompt was queued mid-turn-1)

  // Turn 2's read_notes still saw the decision → the racing submit-prompt did
  // not clear the board out from under the about-to-register detached batch.
  expect(readNotesOutput(events)).toContain("BOARD_DECISION_RACE");

  await engine.finalize();
  await collector;
}, 15_000);
