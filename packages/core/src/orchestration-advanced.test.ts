import { test, expect, afterAll } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoProfile, ToolContext, ToolDefinition, UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";
import { ReportStore, buildReadReportTool } from "./orchestration/report-store.ts";
import { spawnGit } from "./git-info.ts";

// ── shared test scaffolding ────────────────────────────────────────────────

const tmpDirs: string[] = [];
function tmpCwd(): string {
  const d = mkdtempSync(join(tmpdir(), "vibe-orch-adv-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

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
function spawnTasksStep(tasks: unknown[]) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "p1", toolName: "spawn_tasks", input: JSON.stringify({ tasks }) },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]);
}
function toolCallStep(toolName: string, input: unknown, id = "c1") {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]);
}

function mockRegistry(model: MockLanguageModelV2, recordedIds?: string[]) {
  return new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: (modelId: string) => {
        recordedIds?.push(modelId);
        return model;
      },
      listModels: async () => [],
    },
  ]);
}

function orchestrationConfig() {
  const c = { ...defaultConfig() };
  c.orchestration = { enabled: true };
  return c;
}

/** Collect every bus event for later assertions. */
function collect(bus: EventBus): { events: UIEvent[]; done: Promise<void> } {
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const done = (async () => {
    for await (const e of sub) events.push(e);
  })();
  return { events, done };
}

function fakeProfile(commands: RepoProfile["commands"]): RepoProfile {
  return {
    greenfield: false,
    primaryLanguage: null,
    packageManager: null,
    framework: null,
    commands,
    monorepo: { tool: null, packages: [] },
    git: { isRepo: false, branch: null, dirty: false },
    conventions: [],
    manifestFiles: [],
  };
}

// ── 1. structured handoff → dependent kickoff round trip ────────────────────

test("a dependency's handoff propagates verbatim into the dependent's kickoff (not a prose slice)", async () => {
  const prompts: string[] = [];
  // Child a's report carries a prose sentinel AND a handoff fence. The dependent
  // should receive the handoff's key_facts + a read_report pointer, NOT the prose.
  const aReport =
    "PROSE_SLICE_SENTINEL — lots of narration a dependent should NOT be flooded with.\n\n" +
    "```handoff\n" +
    "key_facts:\n" +
    "- KEYFACT_SENTINEL is the new exported API\n" +
    "files_touched:\n" +
    "- src/a.ts\n" +
    "```";
  const steps = [
    spawnTasksStep([
      { id: "a", objective: "do task A" },
      { id: "b", objective: "do task B", deps: ["a"] },
    ]),
    textStep(aReport), // child a
    textStep("B done"), // child b
    textStep("wrapped"), // parent wrap
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify((options as { prompt?: unknown }).prompt ?? ""));
      return steps[call++] as never;
    },
  });

  const bus = new EventBus();
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

  // Child b's kickoff is the prompt that carries its objective.
  const bKickoff = prompts.find((p) => p.includes("do task B"));
  expect(bKickoff).toBeDefined();
  expect(bKickoff!).toContain("KEYFACT_SENTINEL is the new exported API");
  expect(bKickoff!).toContain('read_report(\\"a\\")'); // pointer (JSON-escaped quotes)
  expect(bKickoff!).not.toContain("PROSE_SLICE_SENTINEL");
});

// ── 2. read_report returns the full report + caps at 32k ────────────────────

test("read_report returns a task's full report, and caps an oversized one at 32k", async () => {
  const store = new ReportStore(tmpCwd(), "ses_read");
  const full = "FULL_REPORT_BODY line\n".repeat(50);
  store.set("a", { objective: "A", output: full });
  store.set("big", { objective: "B", output: "x".repeat(40_000) });
  const tool = buildReadReportTool(store);
  const ctx = { cwd: ".", sessionId: "s", abortSignal: new AbortController().signal, emit() {}, toolCallId: "t" } as ToolContext;

  const hit = await tool.execute({ task_id: "a" }, ctx);
  expect(String(hit.output)).toContain("FULL_REPORT_BODY");
  expect(hit.isError).toBeUndefined();

  const big = await tool.execute({ task_id: "big" }, ctx);
  expect(String(big.output)).toContain("truncated at 32000 chars");
  expect(String(big.output).length).toBeLessThan(40_000);

  const miss = await tool.execute({ task_id: "nope" }, ctx);
  expect(miss.isError).toBe(true);
});

// ── 3. model-tier resolution ────────────────────────────────────────────────

test("tier resolves to the configured tier model; absent tier falls back to subagent.model", async () => {
  const ids: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => (call++ === 0 ? spawnTasksStep([
      { id: "x", objective: "strong task", tier: "strong" },
      { id: "y", objective: "default task" },
    ]) : textStep("done")) as never,
  });
  const config = orchestrationConfig();
  config.build.models = { strong: "mock/strong-model" };
  config.subagent.model = "mock/subagent-default";

  const bus = new EventBus();
  const session = new Session({
    config,
    registry: mockRegistry(model, ids),
    toolset: new Toolset([]),
    bus,
    cwd: tmpCwd(),
    model: "mock/parent",
    mode: "execute",
  });
  await session.run("route by tier");
  bus.close();

  // The tier:"strong" child resolved the configured strong model; the untiered
  // child fell through to subagent.model. (The parent used "mock/parent".)
  expect(ids).toContain("strong-model");
  expect(ids).toContain("subagent-default");
});

// ── 4. check:true red gate fails the attempt without an LLM review ───────────

test("check:true with a red gate fails the attempt on PASS/FAIL text, with no LLM review call", async () => {
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => (call++ === 0
      ? spawnTasksStep([{ id: "t", objective: "make a change", check: true }])
      : textStep("did the change")) as never,
  });
  const bus = new EventBus();
  const { events, done } = collect(bus);

  const session = new Session({
    config: orchestrationConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: tmpCwd(),
    model: "mock/test",
    mode: "execute",
    // `false` exits non-zero → the typecheck gate goes RED.
    repoProfile: fakeProfile({ typecheck: "false" }),
  });
  await session.run("do it and check");
  bus.close();
  await done;

  const finished = events.find((e) => e.type === "tool-call-finished" && e.toolName === "spawn_tasks");
  const out = finished && finished.type === "tool-call-finished" ? String(finished.output) : "";
  expect(out).toContain("FAIL typecheck");
  expect(out).toContain("Checks failed");
  expect(out).toContain("0 completed");
  // Exactly one child (the worker) ran — the red gate short-circuited BEFORE any
  // reviewer was spawned. parent(1) + worker(1) + parent-wrap(1) = 3 model calls.
  const started = events.filter((e) => e.type === "subagent-started");
  expect(started.length).toBe(1);
  expect(call).toBe(3);
});

// ── 4b. an aborted (Esc mid-gate) shared task fails with no retry ────────────

test("verify task: an Esc during the gate settles the task failed, with no retry", async () => {
  // The check blocks until the test releases it, so we can Esc while the gate is
  // mid-run; releasing lets the aborted check exit cleanly (no wedged reader).
  const cwd = tmpCwd();
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => (call++ === 0
      ? spawnTasksStep([{ id: "t", objective: "make a change", verify: true }])
      : textStep("did the change")) as never,
  });
  const bus = new EventBus();
  const { events, done } = collect(bus);

  const session = new Session({
    config: orchestrationConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd,
    model: "mock/test",
    mode: "execute",
    repoProfile: fakeProfile({
      typecheck: "echo started > gate-started; until [ -f release ]; do sleep 0.05; done",
    }),
  });

  // Esc mid-gate: once the check subprocess has started (its marker file), abort
  // the session and release the check so it exits cleanly.
  const marker = join(cwd, "gate-started");
  const watcher = (async () => {
    const deadline = Date.now() + 15_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    session.abort();
    writeFileSync(join(cwd, "release"), "");
  })();

  await session.run("do it and verify");
  await watcher;
  bus.close();
  await done;

  // The task settled FAILED on the interrupt — a terminal non-verdict.
  const failed = events.find(
    (e) => e.type === "orchestration-task" && e.taskId === "t" && e.status === "failed",
  );
  expect(failed).toBeDefined();
  // And the interrupt did NOT trigger a retry: verifyMaxAttempts is 2, so a RED
  // gate would have run a second worker; an aborted gate runs exactly one.
  expect(events.filter((e) => e.type === "subagent-started").length).toBe(1);
});

// ── 5. the reviewer gets the REAL diff ──────────────────────────────────────

test("a verify task's reviewer prompt contains the real git diff of the task's files", async () => {
  const cwd = tmpCwd();
  await spawnGit(cwd, ["init", "-q"]);
  await spawnGit(cwd, ["config", "user.email", "t@t.co"]);
  await spawnGit(cwd, ["config", "user.name", "tester"]);
  writeFileSync(join(cwd, "foo.ts"), "export const x = 1;\n");
  await spawnGit(cwd, ["add", "."]);
  await spawnGit(cwd, ["commit", "-q", "-m", "init"]);

  // A mutating tool that actually edits foo.ts on disk (→ a real unstaged diff).
  const apply: ToolDefinition<Record<string, never>> = {
    name: "apply",
    description: "edit the file",
    inputSchema: z.object({}),
    readOnly: false,
    concurrencySafe: false,
    async execute() {
      appendFileSync(join(cwd, "foo.ts"), "const MARKER_DIFF_HUNK = 2;\n");
      return { output: "edited foo.ts" };
    },
  };

  const prompts: string[] = [];
  const steps = [
    spawnTasksStep([{ id: "t", objective: "edit foo", files: ["foo.ts"], verify: true }]),
    toolCallStep("apply", {}), // worker mutates foo.ts
    textStep("edited the file"), // worker report
    textStep("REVIEW-CLEAN"), // reviewer verdict
    textStep("wrapped"), // parent wrap
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify((options as { prompt?: unknown }).prompt ?? ""));
      return steps[call++] as never;
    },
  });

  const bus = new EventBus();
  const session = new Session({
    config: orchestrationConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([apply]),
    bus,
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("edit and verify");
  bus.close();

  // The reviewer prompt (the one carrying the diff block) must include the added
  // line from the real `git diff`, not just the worker's self-report.
  const reviewPrompt = prompts.find((p) => p.includes("The ACTUAL diff of the task's changes"));
  expect(reviewPrompt).toBeDefined();
  expect(reviewPrompt!).toContain("MARKER_DIFF_HUNK");
});

// ── 6. tree-global spawn ceiling ────────────────────────────────────────────

test("the spawn ceiling errors the task that would exceed subagent.maxTotal", async () => {
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => (call++ === 0
      ? spawnTasksStep([
          { id: "a", objective: "A" },
          { id: "b", objective: "B" },
          { id: "c", objective: "C" },
        ])
      : textStep("done")) as never,
  });
  const config = orchestrationConfig();
  config.subagent.maxTotal = 2; // only two children may ever be spawned

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: tmpCwd(),
    model: "mock/test",
    mode: "execute",
  });
  await session.run("spawn three under a cap of two");
  bus.close();
  await done;

  const finished = events.find((e) => e.type === "tool-call-finished" && e.toolName === "spawn_tasks");
  const out = finished && finished.type === "tool-call-finished" ? String(finished.output) : "";
  // Two completed, the third hit the budget and failed with the ceiling message.
  expect(out).toContain("2 completed");
  expect(out).toContain("Subagent budget exhausted");
  const started = events.filter((e) => e.type === "subagent-started");
  expect(started.length).toBe(2);
});

// ── 7. journal seed skips completed tasks on a re-run ────────────────────────

test("a re-submitted plan re-runs only unfinished tasks (journal seed)", async () => {
  const cwd = tmpCwd();
  // Same tasks submitted twice in the same session. Turn 1 completes both and
  // journals them; turn 2 seeds from the journal and re-runs neither.
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      const c = call++;
      // Turn 1: call0 = spawn_tasks, calls 1-2 = children, call3 = wrap.
      // Turn 2: call4 = spawn_tasks (all seeded → no children), call5 = wrap.
      if (c === 0 || c === 4) {
        return spawnTasksStep([
          { id: "a", objective: "task A" },
          { id: "b", objective: "task B" },
        ]) as never;
      }
      return textStep(`done ${c}`) as never;
    },
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: orchestrationConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd,
    model: "mock/test",
    mode: "execute",
  });

  await session.run("run the plan"); // turn 1 completes + journals both
  await session.run("run the plan again"); // turn 2 seeds from the journal
  bus.close();
  await done;

  // Exactly TWO children were ever spawned: turn 1 ran both tasks; turn 2 seeded
  // them from the journal and spawned none. (Without seeding this would be four.)
  const started = events.filter((e) => e.type === "subagent-started").length;
  expect(started).toBe(2);

  // Turn 2 still reports both tasks completed (from the seeded results).
  const finishes = events.filter((e) => e.type === "tool-call-finished" && e.toolName === "spawn_tasks");
  const lastOut = finishes.at(-1);
  const out = lastOut && lastOut.type === "tool-call-finished" ? String(lastOut.output) : "";
  expect(out).toContain("2 completed");
});
