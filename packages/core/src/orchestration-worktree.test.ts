import { test, expect, afterAll } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoProfile, ToolDefinition, UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { FreshnessRegistry } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";
import { spawnGit } from "./git-info.ts";
import { commitWorktree, gitAddWorktree, gitMergeWorktreeBranch } from "./build/gitops.ts";
import { worktreeSlug } from "./orchestration/orchestrator-runner.ts";

// ── shared test scaffolding (mirrors orchestration-advanced.test.ts) ─────────

const tmpDirs: string[] = [];
function tmpCwd(): string {
  const d = mkdtempSync(join(tmpdir(), "vibe-orch-wt-"));
  tmpDirs.push(d);
  return d;
}
async function gitRepo(): Promise<string> {
  const cwd = tmpCwd();
  await spawnGit(cwd, ["init", "-q", "-b", "main"]);
  await spawnGit(cwd, ["config", "user.email", "t@t.co"]);
  await spawnGit(cwd, ["config", "user.name", "tester"]);
  writeFileSync(join(cwd, "seed.txt"), "seed\n");
  await spawnGit(cwd, ["add", "-A"]);
  await spawnGit(cwd, ["commit", "-q", "-m", "init"]);
  return cwd;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({
      chunks: chunks as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}
function textStep(delta: string) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop" as const, raw: undefined }, usage: USAGE },
  ]);
}
function spawnTasksStep(tasks: unknown[]) {
  return stream([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "p1",
      toolName: "spawn_tasks",
      input: JSON.stringify({ tasks }),
    },
    { type: "finish", finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: USAGE },
  ]);
}
function toolCallStep(toolName: string, input: unknown, id = "c1") {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: USAGE },
  ]);
}

function mockRegistry(model: MockLanguageModelV3) {
  return new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => model,
      listModels: async () => [],
    },
  ]);
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
    git: { isRepo: true, branch: "main", dirty: false },
    conventions: [],
    manifestFiles: [],
  };
}

/** A tool that really writes to `input.path` (relative to the child's cwd — which
 * is the worktree for a worktree/ensemble task, the shared tree otherwise), so a
 * mock child produces a genuine on-disk diff the merge can carry. */
const applyTool: ToolDefinition<{ path?: string; content: string }> = {
  name: "apply",
  description: "write a file",
  inputSchema: z.object({ path: z.string().optional(), content: z.string() }),
  readOnly: false,
  concurrencySafe: false,
  async execute({ path, content }, ctx) {
    writeFileSync(join(ctx.cwd, path ?? "shared.txt"), `${content}\n`);
    return { output: "APPLIED" };
  },
};

/** Drive the mock from the prompt text so it is robust to the non-deterministic
 * interleaving of PARALLEL children (a global step counter would break). */
function routedModel(route: (promptJson: string) => unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async (options) =>
      route(JSON.stringify((options as { prompt?: unknown }).prompt ?? "")) as never,
  });
}

function orchConfig() {
  const c = { ...defaultConfig() };
  c.orchestration = { enabled: true };
  return c;
}

// ── worktree slug: distinct ids that sanitize alike must NOT collide ─────────

test("worktreeSlug disambiguates ids that sanitize to the same fragment", () => {
  // `auth.login` and `auth_login` both sanitize to `auth_login`; without a hash
  // of the FULL id they'd share one worktree path/branch and the second task's
  // gitAddWorktree would force-remove the first's live worktree.
  expect(worktreeSlug("auth.login")).not.toBe(worktreeSlug("auth_login"));
  // …but the human-readable prefix is preserved for both.
  expect(worktreeSlug("auth.login").startsWith("auth_login-")).toBe(true);
  expect(worktreeSlug("auth_login").startsWith("auth_login-")).toBe(true);
  // Stable: same id → same slug (deterministic path/branch across a resume).
  expect(worktreeSlug("auth.login")).toBe(worktreeSlug("auth.login"));
  // Two >64-char ids differing only past char 64 also stay distinct.
  const a = `x${"y".repeat(70)}A`;
  const b = `x${"y".repeat(70)}B`;
  expect(worktreeSlug(a)).not.toBe(worktreeSlug(b));
});

// ── gitops units: commitWorktree + non-destructive merge cleanup ─────────────

test("commitWorktree commits a worktree's work; returns false when nothing changed", async () => {
  const cwd = await gitRepo();
  const wtPath = join(cwd, ".vibe", "worktrees", "u1");
  await gitAddWorktree(cwd, { path: wtPath, branch: "vibe-wt/u1" });
  // Nothing changed yet → no commit.
  expect(await commitWorktree(wtPath, "noop")).toBe(false);
  writeFileSync(join(wtPath, "new.txt"), "hello\n");
  expect(await commitWorktree(wtPath, "add new.txt")).toBe(true);
  const log = await spawnGit(wtPath, ["log", "-1", "--format=%an <%ae>"]);
  expect(log.stdout.trim()).toBe("vibecodr <agent@vibecodr.local>");
});

test("a refused second squash-merge does NOT clobber a prior merge's staged changes", async () => {
  // The core reason merges are serialized AND why the failure cleanup is targeted:
  // two worktree tasks squash-merge into ONE uncommitted main tree. The first
  // stages its change; the second (same file) is REFUSED by git — and the cleanup
  // must leave the first's staged work intact (a blanket `git reset` wiped it).
  const cwd = await gitRepo();
  const a = join(cwd, ".vibe", "worktrees", "m-a");
  const b = join(cwd, ".vibe", "worktrees", "m-b");
  await gitAddWorktree(cwd, { path: a, branch: "vibe-wt/m-a" });
  await gitAddWorktree(cwd, { path: b, branch: "vibe-wt/m-b" });
  writeFileSync(join(a, "seed.txt"), "seed\nfrom-A\n");
  writeFileSync(join(b, "seed.txt"), "from-B\nseed\n");
  await commitWorktree(a, "a");
  await commitWorktree(b, "b");

  expect(await gitMergeWorktreeBranch(cwd, "vibe-wt/m-a")).toBe(true); // stages seed.txt
  expect(await gitMergeWorktreeBranch(cwd, "vibe-wt/m-b")).toBe(false); // refused
  // A's change must have survived B's refusal + cleanup.
  expect(readFileSync(join(cwd, "seed.txt"), "utf8")).toContain("from-A");
  expect(readFileSync(join(cwd, "seed.txt"), "utf8")).not.toContain("from-B");
});

// ── worktree tasks: same relative path (parallel writers, serialized merges) ──
//
// FINDING (verified in-test): two worktree tasks that both touch the SAME file
// cannot BOTH squash-merge into one uncommitted tree. The first stages the file;
// git then refuses the second ("local changes would be overwritten") because we
// never auto-commit the main tree between merges. That refusal is the honest
// outcome — the losing task fails with the conflict feedback, not a corrupt tree.

test("two parallel worktree tasks on the SAME path: one merges, the other fails with the conflict message", async () => {
  const cwd = await gitRepo();
  const model = routedModel((p) => {
    if (p.includes("SAMEFILE-RUN")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([
            { id: "wa", objective: "task-wa: write the shared file", worktree: true },
            { id: "wb", objective: "task-wb: write the shared file", worktree: true },
          ]);
    }
    if (p.includes("APPLIED")) return textStep("child report");
    // Distinct content per child guarantees the second merge is genuinely refused.
    return toolCallStep("apply", { content: p.includes("task-wa") ? "AAA" : "BBB" });
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: orchConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([applyTool]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("SAMEFILE-RUN");
  bus.close();
  await done;

  const orch = events.filter(
    (e): e is Extract<UIEvent, { type: "orchestration-task" }> => e.type === "orchestration-task",
  );
  const completed = orch.filter((e) => e.status === "completed").map((e) => e.taskId);
  const failed = orch.filter((e) => e.status === "failed").map((e) => e.taskId);
  expect(completed.length).toBe(1);
  expect(failed.length).toBe(1);

  const out = spawnTasksOutput(events);
  expect(out).toContain("merge conflict — changes discarded");
  // The winner's content landed in the main tree; both worktrees were cleaned up.
  expect(readFileSync(join(cwd, "shared.txt"), "utf8").trim()).toMatch(/^(AAA|BBB)$/);
  expect(await worktreeBranches(cwd)).toEqual([]);
  // The real worktree dirs are slugged `wa-<hash>` / `wb-<hash>`, so asserting on
  // the bare id name was vacuous. Assert NO worktree dir survives teardown.
  expect(worktreeDirs(cwd)).toEqual([]);
});

/** Names of surviving per-task worktree dirs under .vibe/worktrees (empty when
 * all were torn down). Slugged `<id>-<hash>`, so we can't assert on bare ids. */
function worktreeDirs(cwd: string): string[] {
  const dir = join(cwd, ".vibe", "worktrees");
  return existsSync(dir) ? readdirSync(dir) : [];
}

// ── worktree tasks: disjoint files (both merge back) ─────────────────────────

test("two parallel worktree tasks on DIFFERENT paths both merge back cleanly", async () => {
  const cwd = await gitRepo();
  const model = routedModel((p) => {
    if (p.includes("DIFFFILES-RUN")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([
            { id: "da", objective: "task-da: write a.txt", worktree: true, files: ["a.txt"] },
            { id: "db", objective: "task-db: write b.txt", worktree: true, files: ["b.txt"] },
          ]);
    }
    if (p.includes("APPLIED")) return textStep("child report");
    return p.includes("task-da")
      ? toolCallStep("apply", { path: "a.txt", content: "AAA" })
      : toolCallStep("apply", { path: "b.txt", content: "BBB" });
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: orchConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([applyTool]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("DIFFFILES-RUN");
  bus.close();
  await done;

  const out = spawnTasksOutput(events);
  expect(out).toContain("2 completed");
  // Both changes landed, squash-merged into the shared main tree.
  expect(readFileSync(join(cwd, "a.txt"), "utf8").trim()).toBe("AAA");
  expect(readFileSync(join(cwd, "b.txt"), "utf8").trim()).toBe("BBB");
  expect(await worktreeBranches(cwd)).toEqual([]);
});

// ── worktree unavailable → shared-tree fallback ──────────────────────────────

test("a worktree task in a non-git cwd falls back to shared-tree execution", async () => {
  const cwd = tmpCwd(); // NOT a git repo → gitAddWorktree returns null
  const model = routedModel((p) => {
    if (p.includes("FALLBACK-RUN")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([{ id: "t", objective: "do the work", worktree: true }]);
    }
    if (p.includes("APPLIED")) return textStep("child report");
    return toolCallStep("apply", { path: "out.txt", content: "shared-tree" });
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: orchConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([applyTool]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("FALLBACK-RUN");
  bus.close();
  await done;

  const out = spawnTasksOutput(events);
  expect(out).toContain("1 completed");
  // The child ran in the shared (non-git) tree and its write landed there.
  expect(readFileSync(join(cwd, "out.txt"), "utf8").trim()).toBe("shared-tree");
  const notice = events.find(
    (e) => e.type === "notice" && e.message.includes("worktree unavailable"),
  );
  expect(notice).toBeDefined();
});

// ── best-of-N ensemble: gate-judged, only the winner merges ──────────────────

test("ensemble (n=2, hard): the attempt that passes the in-worktree gate wins; loser is discarded", async () => {
  const cwd = await gitRepo();
  const config = orchConfig();
  config.build.ensemble = { n: 2 };
  // Attempt with the MINIMAL-DIFF strategy writes GOOD (gate green); the other
  // writes BAD (gate red). The gate greps for GOOD inside each worktree.
  const model = routedModel((p) => {
    if (p.includes("ENSEMBLE-RUN")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([{ id: "hard", objective: "solve the hard task", hard: true }]);
    }
    if (p.includes("APPLIED")) return textStep("attempt report");
    return toolCallStep("apply", {
      path: "result.txt",
      content: p.includes("MINIMAL-DIFF") ? "GOOD" : "BAD",
    });
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([applyTool]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
    repoProfile: fakeProfile({ typecheck: "grep -q GOOD result.txt" }),
  });
  await session.run("ENSEMBLE-RUN");
  bus.close();
  await done;

  const out = spawnTasksOutput(events);
  expect(out).toContain("1 completed");
  // The winner's GOOD content landed in the main tree…
  expect(readFileSync(join(cwd, "result.txt"), "utf8").trim()).toBe("GOOD");
  // …and every attempt's worktree + branch was cleaned up (no losers linger).
  expect(await worktreeBranches(cwd)).toEqual([]);
  // Two attempts ran (both children were spawned).
  const started = events.filter((e) => e.type === "subagent-started").length;
  expect(started).toBe(2);
});

// ── interrupted child → failed task, NO partial merge ────────────────────────
//
// FINDING: an aborted/interrupted child sets `interrupted=true` but leaves
// `lastError=null`. #childOutcome must NOT read that as a clean completion — a
// worktree task would otherwise commit + squash-merge the child's PARTIAL edits
// into the main tree and journal the task "completed" (silent data loss on resume).

test("an interrupted worktree child fails the task and does NOT merge its partial work", async () => {
  const cwd = await gitRepo();
  // The child writes a partial file, then — mid-turn — the parent session is
  // aborted (the user presses Esc). The abort propagates to the child (Session
  // marks it `interrupted`, NOT `lastError`), so the child's next step unwinds.
  const holder: { abort: () => void } = { abort: () => {} };
  const interruptingApply: ToolDefinition<{ path?: string; content: string }> = {
    ...applyTool,
    async execute(args, ctx) {
      const r = await applyTool.execute(args, ctx);
      holder.abort(); // Esc: aborts the parent turn while this child is mid-run.
      return r;
    },
  };
  const model = routedModel((p) => {
    if (p.includes("INTERRUPT-RUN")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([
            { id: "t", objective: "task-x: write then get interrupted", worktree: true },
          ]);
    }
    if (p.includes("APPLIED")) return textStep("should never finish"); // aborted before this lands
    return toolCallStep("apply", { path: "leak.txt", content: "PARTIAL" });
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: orchConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([interruptingApply]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  holder.abort = () => session.abort();
  await session.run("INTERRUPT-RUN");
  bus.close();
  await done;

  const orch = events.filter(
    (e): e is Extract<UIEvent, { type: "orchestration-task" }> => e.type === "orchestration-task",
  );
  expect(orch.some((e) => e.status === "failed" && e.taskId === "t")).toBe(true);
  expect(orch.some((e) => e.status === "completed")).toBe(false);
  // The child's PARTIAL edit must NOT have been committed + merged into the main tree.
  expect(existsSync(join(cwd, "leak.txt"))).toBe(false);
  // And the worktree + branch were still cleaned up (the finally teardown ran).
  expect(await worktreeBranches(cwd)).toEqual([]);
});

// ── ensemble re-gates the MERGED tree, not just each isolated worktree ────────
//
// FINDING (V2 §4): #runEnsembleTask merged the winner and settled `completed`
// with NO gate on the combined tree — unlike #runWorktreeTask, which re-runs the
// gate on the merged main tree. The winner's green was produced in ISOLATION off
// a checkout that lacks the main tree's untracked/gitignored state, so a hard
// task could land a red main tree while reporting success.
test("ensemble re-gates the merged tree — a winner green in isolation but red combined fails", async () => {
  const cwd = await gitRepo();
  const config = orchConfig();
  config.build.ensemble = { n: 2 };
  // An UNTRACKED file present only in the main tree (a worktree checks out
  // tracked files only): the gate `test ! -f block.txt` is green inside each
  // isolated worktree but red after the winner merges into the main tree.
  writeFileSync(join(cwd, "block.txt"), "x\n");
  const model = routedModel((p) => {
    if (p.includes("ENS-MERGE-GATE")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([{ id: "hard", objective: "solve", hard: true, check: true }]);
    }
    if (p.includes("APPLIED")) return textStep("attempt report");
    return toolCallStep("apply", {
      path: "result.txt",
      content: p.includes("MINIMAL-DIFF") ? "GOOD" : "BAD",
    });
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([applyTool]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
    repoProfile: fakeProfile({ typecheck: "test ! -f block.txt" }),
  });
  await session.run("ENS-MERGE-GATE");
  bus.close();
  await done;

  const orch = events.filter(
    (e): e is Extract<UIEvent, { type: "orchestration-task" }> => e.type === "orchestration-task",
  );
  // The winner passed in isolation but the merged tree is red → the task FAILS,
  // instead of the old silent "completed" on a red main tree.
  expect(orch.some((e) => e.status === "failed" && e.taskId === "hard")).toBe(true);
  expect(orch.some((e) => e.status === "completed")).toBe(false);
  const out = spawnTasksOutput(events);
  expect(out).toMatch(/MERGED tree is red.*reverted/i);
  // The winner's squash-merged result.txt was REVERTED — main is not left holding
  // the failing changes (the old bug landed them despite reporting failure).
  expect(existsSync(join(cwd, "result.txt"))).toBe(false);
  // Every attempt's worktree + branch was still cleaned up.
  expect(await worktreeBranches(cwd)).toEqual([]);
});

// ── a task's ```handoff fence is stripped from its report prose ───────────────
//
// FINDING (V2 §4): stripHandoffFence was dead (no call site), so the child's raw
// ```handoff machine block was stored verbatim in the report + threaded into the
// planner summary and dependents' kickoffs as noise (the structured handoff is
// already surfaced separately).
test("a task's handoff fence is stripped from its report prose", async () => {
  const cwd = await gitRepo();
  const fenced =
    'Implemented the parser.\n```handoff\n{"keyFacts":["parser done"],"filesTouched":["p.ts"],"openQuestions":[]}\n```';
  const model = routedModel((p) => {
    if (p.includes("FENCE-RUN")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([{ id: "t", objective: "build the parser" }]);
    }
    return textStep(fenced); // the child's final message carries the fence
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: orchConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("FENCE-RUN");
  bus.close();
  await done;

  const out = spawnTasksOutput(events);
  expect(out).toContain("Implemented the parser."); // prose kept
  expect(out).not.toContain("```handoff"); // machine fence stripped
});

// ── ensemble on an unborn HEAD → shared-tree fallback (never hard-fail) ───────

test("a hard/ensemble task in a repo with no commits falls back to the shared tree", async () => {
  const cwd = tmpCwd();
  await spawnGit(cwd, ["init", "-q", "-b", "main"]); // unborn HEAD — inside a work tree but no commit
  const config = orchConfig();
  config.build.ensemble = { n: 2 };
  const model = routedModel((p) => {
    if (p.includes("UNBORN-RUN")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([{ id: "h", objective: "solve it", hard: true }]);
    }
    if (p.includes("APPLIED")) return textStep("done");
    return toolCallStep("apply", { path: "made.txt", content: "shared" });
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([applyTool]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("UNBORN-RUN");
  bus.close();
  await done;

  const out = spawnTasksOutput(events);
  expect(out).toContain("1 completed");
  // It ran in the shared tree (its write landed there) rather than failing every
  // 'worktree-unavailable' ensemble attempt.
  expect(readFileSync(join(cwd, "made.txt"), "utf8").trim()).toBe("shared");
  const notice = events.find(
    (e) => e.type === "notice" && e.message.includes("worktrees unavailable"),
  );
  expect(notice).toBeDefined();
});

// ── worktree task gate runs on the merged tree (inside the merge lock) ────────

test("a worktree task with check:true fails when the merged tree is red", async () => {
  const cwd = await gitRepo();
  const model = routedModel((p) => {
    if (p.includes("GATE-RUN")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([
            { id: "g", objective: "task-g: write BAD", worktree: true, check: true },
          ]);
    }
    if (p.includes("APPLIED")) return textStep("child report");
    return toolCallStep("apply", { path: "result.txt", content: "BAD" });
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: orchConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([applyTool]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
    repoProfile: fakeProfile({ typecheck: "grep -q GOOD result.txt" }),
  });
  await session.run("GATE-RUN");
  bus.close();
  await done;

  const out = spawnTasksOutput(events);
  // The gate ran on the MERGED main tree and was red → the task failed.
  expect(out).toContain("Checks failed on the merged tree");
  // And the failing squash-merge was REVERTED — main is NOT left holding the BAD
  // content (the old behavior landed it despite reporting failure; V2 adversarial
  // pass 1 caught that dirty-tree bug).
  expect(existsSync(join(cwd, "result.txt"))).toBe(false);
  expect(await worktreeBranches(cwd)).toEqual([]);
});

// ── live child activity tap ──────────────────────────────────────────────────

test("a running child's tool calls surface as subagent-activity on the PARENT bus; the tap closes on finish", async () => {
  const cwd = tmpCwd();
  let call = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const steps = [
        toolCallStep("spawn_subagent", { prompt: "child: run a command" }), // parent
        toolCallStep("bash", { command: "echo hello-activity" }), // child tool call
        textStep("child done"), // child report
        textStep("wrapped"), // parent wrap
      ];
      return steps[call++] as never;
    },
  });
  // A no-op "bash" so the tool call streams (its side effect is irrelevant here).
  const bash: ToolDefinition<{ command: string }> = {
    name: "bash",
    description: "run",
    inputSchema: z.object({ command: z.string() }),
    readOnly: true,
    concurrencySafe: true,
    async execute() {
      return { output: "ran" };
    },
  };

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: orchConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([bash]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("TAP-RUN");
  bus.close();
  await done;

  const started = events.find(
    (e): e is Extract<UIEvent, { type: "subagent-started" }> => e.type === "subagent-started",
  );
  expect(started).toBeDefined();
  const childId = started!.subagentId;

  const activity = events.filter(
    (e): e is Extract<UIEvent, { type: "subagent-activity" }> => e.type === "subagent-activity",
  );
  expect(activity.length).toBeGreaterThanOrEqual(1);
  // Attributed to the CHILD, re-emitted under the PARENT's sessionId, with the
  // bash-specific "$ <command head>" label.
  expect(activity.every((e) => e.subagentId === childId)).toBe(true);
  expect(activity.every((e) => e.sessionId === session.id)).toBe(true);
  expect(activity.some((e) => e.label === "$ echo hello-activity")).toBe(true);

  // The tap is torn down when the child finishes: no activity after the finish.
  const finishedIdx = events.findIndex((e) => e.type === "subagent-finished");
  const lastActivityIdx = events.map((e) => e.type).lastIndexOf("subagent-activity");
  expect(finishedIdx).toBeGreaterThanOrEqual(0);
  expect(lastActivityIdx).toBeLessThan(finishedIdx);
});

// ── structured output on the worktree + ensemble paths ──────────────────────
//
// Regression: outputSchema was enforced ONLY on the shared-tree path — a worktree
// or ensemble task silently dropped the contract and settled `completed` with
// unvalidated prose. Both paths now validate the child's final message.

const STATUS_SCHEMA = {
  type: "object",
  required: ["status"],
  properties: { status: { type: "string", enum: ["done"] } },
};

test("a worktree task with outputSchema settles completed with the VALIDATED json report", async () => {
  const cwd = await gitRepo();
  const model = routedModel((p) => {
    if (p.includes("WT-SCHEMA-OK")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([
            {
              id: "t",
              objective: "task-wtok: write then report json",
              worktree: true,
              outputSchema: STATUS_SCHEMA,
            },
          ]);
    }
    // After the write lands, the FINAL message is exactly the required JSON.
    if (p.includes("APPLIED")) return textStep(JSON.stringify({ status: "done" }));
    return toolCallStep("apply", { path: "out.txt", content: "x" });
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: orchConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([applyTool]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("WT-SCHEMA-OK");
  bus.close();
  await done;

  const out = spawnTasksOutput(events);
  expect(out).toContain("1 completed");
  // The report is the canonical validated JSON, not the raw prose.
  expect(out).toContain('{"status":"done"}');
  // The write still merged into the main tree.
  expect(readFileSync(join(cwd, "out.txt"), "utf8").trim()).toBe("x");
});

test("a worktree task whose final message violates outputSchema fails (not silently completed)", async () => {
  const cwd = await gitRepo();
  const model = routedModel((p) => {
    if (p.includes("WT-SCHEMA-BAD")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([
            {
              id: "t",
              objective: "task-wtbad: write then report prose",
              worktree: true,
              outputSchema: STATUS_SCHEMA,
            },
          ]);
    }
    // FINAL message is prose, not JSON — the schema contract is violated.
    if (p.includes("APPLIED")) return textStep("I could not produce the JSON you asked for.");
    return toolCallStep("apply", { path: "out.txt", content: "x" });
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: orchConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([applyTool]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("WT-SCHEMA-BAD");
  bus.close();
  await done;

  const out = spawnTasksOutput(events);
  expect(out).toContain("0 completed");
  expect(out).toContain("Structured output invalid");
  // Validation runs BEFORE the merge, so the unvalidated work was NOT landed.
  expect(existsSync(join(cwd, "out.txt"))).toBe(false);
});

test("an ensemble winner whose final message violates outputSchema fails; unvalidated prose is not merged", async () => {
  const cwd = await gitRepo();
  const config = orchConfig();
  config.build.ensemble = { n: 2 };
  const model = routedModel((p) => {
    if (p.includes("ENS-SCHEMA-BAD")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([
            {
              id: "hard",
              objective: "solve the hard task",
              hard: true,
              outputSchema: STATUS_SCHEMA,
            },
          ]);
    }
    // The gate greps for GOOD → the MINIMAL-DIFF attempt wins on score, but its
    // FINAL message is prose, so the winner fails schema enforcement.
    if (p.includes("APPLIED")) return textStep("prose, not the required JSON");
    return toolCallStep("apply", {
      path: "result.txt",
      content: p.includes("MINIMAL-DIFF") ? "GOOD" : "BAD",
    });
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([applyTool]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
    repoProfile: fakeProfile({ typecheck: "grep -q GOOD result.txt" }),
  });
  await session.run("ENS-SCHEMA-BAD");
  bus.close();
  await done;

  const out = spawnTasksOutput(events);
  expect(out).toContain("0 completed");
  expect(out).toContain("Ensemble winner's structured output invalid");
  // The winner's gate-passing code was NOT merged — the schema gate fails first.
  expect(existsSync(join(cwd, "result.txt"))).toBe(false);
  // Every attempt's worktree + branch was still cleaned up.
  expect(await worktreeBranches(cwd)).toEqual([]);
});

// ── helpers ──────────────────────────────────────────────────────────────────

function spawnTasksOutput(events: UIEvent[]): string {
  const finished = events.find(
    (e): e is Extract<UIEvent, { type: "tool-call-finished" }> =>
      e.type === "tool-call-finished" && e.toolName === "spawn_tasks",
  );
  return finished ? String(finished.output) : "";
}

async function worktreeBranches(cwd: string): Promise<string[]> {
  const r = await spawnGit(cwd, ["branch", "--list", "vibe-wt/*"]);
  return r.stdout
    .split("\n")
    .map((l) => l.replace(/^[*+]?\s*/, "").trim())
    .filter(Boolean);
}

// ── BUG-086: dirty post-merge review must restore squash-merge on main ────────

test("worktree verify:true dirty review reverts the squash-merge on main (BUG-086)", async () => {
  // Gate is green (or skipped with no profile checks). Reviewer returns dirty.
  // Pre-fix: task failed but BAD content stayed on main. Fix restores files.
  const cwd = await gitRepo();
  const model = routedModel((p) => {
    if (p.includes("DIRTY-REVIEW-RUN")) {
      return p.includes("Orchestrated")
        ? textStep("wrapped")
        : spawnTasksStep([
            {
              id: "dirty",
              objective: "task-dirty: write BAD_MARKER into leaked.txt",
              worktree: true,
              verify: true,
              files: ["leaked.txt"],
            },
          ]);
    }
    if (p.includes("The ACTUAL diff of the task's changes") || p.includes("REVIEW")) {
      // Reviewer: findings + REVIEW-CLEAN must still fail isReviewClean; pure findings too.
      return textStep("leaked.txt:1 — BAD_MARKER must not ship\nNOT REVIEW-CLEAN");
    }
    if (p.includes("APPLIED") || p.includes("child report") || p.includes("task-dirty")) {
      if (p.includes("APPLIED")) return textStep("child report with BAD_MARKER");
      return toolCallStep("apply", { path: "leaked.txt", content: "BAD_MARKER" });
    }
    // Default child path: apply then report
    if (p.includes("write BAD_MARKER") || p.includes("leaked")) {
      return toolCallStep("apply", { path: "leaked.txt", content: "BAD_MARKER" });
    }
    return textStep("child report");
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config: orchConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([applyTool]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("DIRTY-REVIEW-RUN");
  bus.close();
  await done;

  const orch = events.filter(
    (e): e is Extract<UIEvent, { type: "orchestration-task" }> => e.type === "orchestration-task",
  );
  const failed = orch.filter((e) => e.status === "failed");
  expect(failed.length).toBeGreaterThanOrEqual(1);
  const out = spawnTasksOutput(events);
  expect(out.toLowerCase()).toMatch(/review|failed|reverted/);
  // Main tree must NOT keep the rejected worktree merge (BUG-086).
  expect(existsSync(join(cwd, "leaked.txt"))).toBe(false);
});
