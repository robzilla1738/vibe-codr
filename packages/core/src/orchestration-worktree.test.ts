import { test, expect, afterAll } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoProfile, ToolDefinition, UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";
import { spawnGit } from "./git-info.ts";
import { commitWorktree, gitAddWorktree, gitMergeWorktreeBranch } from "./build/gitops.ts";

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

function mockRegistry(model: MockLanguageModelV2) {
  return new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
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
function routedModel(route: (promptJson: string) => unknown): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    doStream: async (options) => route(JSON.stringify((options as { prompt?: unknown }).prompt ?? "")) as never,
  });
}

function orchConfig() {
  const c = { ...defaultConfig() };
  c.orchestration = { enabled: true };
  return c;
}

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
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("SAMEFILE-RUN");
  bus.close();
  await done;

  const orch = events.filter((e): e is Extract<UIEvent, { type: "orchestration-task" }> => e.type === "orchestration-task");
  const completed = orch.filter((e) => e.status === "completed").map((e) => e.taskId);
  const failed = orch.filter((e) => e.status === "failed").map((e) => e.taskId);
  expect(completed.length).toBe(1);
  expect(failed.length).toBe(1);

  const out = spawnTasksOutput(events);
  expect(out).toContain("merge conflict — changes discarded");
  // The winner's content landed in the main tree; both worktrees were cleaned up.
  expect(readFileSync(join(cwd, "shared.txt"), "utf8").trim()).toMatch(/^(AAA|BBB)$/);
  expect(await worktreeBranches(cwd)).toEqual([]);
  expect(existsSync(join(cwd, ".vibe", "worktrees", "wa"))).toBe(false);
  expect(existsSync(join(cwd, ".vibe", "worktrees", "wb"))).toBe(false);
});

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
    return toolCallStep("apply", { path: "result.txt", content: p.includes("MINIMAL-DIFF") ? "GOOD" : "BAD" });
  });

  const bus = new EventBus();
  const { events, done } = collect(bus);
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([applyTool]),
    bus,
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

// ── live child activity tap ──────────────────────────────────────────────────

test("a running child's tool calls surface as subagent-activity on the PARENT bus; the tap closes on finish", async () => {
  const cwd = tmpCwd();
  let call = 0;
  const model = new MockLanguageModelV2({
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
    cwd,
    model: "mock/test",
    mode: "execute",
  });
  await session.run("TAP-RUN");
  bus.close();
  await done;

  const started = events.find((e): e is Extract<UIEvent, { type: "subagent-started" }> => e.type === "subagent-started");
  expect(started).toBeDefined();
  const childId = started!.subagentId;

  const activity = events.filter((e): e is Extract<UIEvent, { type: "subagent-activity" }> => e.type === "subagent-activity");
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
  return r.stdout.split("\n").map((l) => l.replace(/^[*+]?\s*/, "").trim()).filter(Boolean);
}
