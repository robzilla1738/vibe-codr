import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Handoff, Mode, ToolDefinition } from "@vibe/shared";
import { createSemaphore, createSerialLock } from "@vibe/tools";
import { EventBus as EventBusImpl } from "../event-bus.ts";
import type { NamedAgent } from "../agents.ts";
import {
  validateDag,
  runDag,
  formatTaskResults,
  type TaskSpec,
  type TaskResult,
} from "../orchestrator.ts";
import type { Session, SessionDeps } from "../session.ts";
import { spawnGit } from "../git-info.ts";
import {
  HANDOFF_INSTRUCTION,
  formatHandoffForKickoff,
  parseHandoff,
} from "../build/handoff.ts";
import {
  appendOrchestrationEvent,
  loadCompletedTasks,
  persistTaskReport,
} from "../build/journal.ts";
import { runGate, formatGateFailure } from "../build/gate.ts";
import {
  gitAddWorktree,
  gitRemoveWorktree,
  gitMergeWorktreeBranch,
  gitDiffSince,
  commitWorktree,
} from "../build/gitops.ts";
import { scanStubs, formatStubFindings } from "../build/stubscan.ts";
import { ReportStore } from "./report-store.ts";

// A subagent's final answer lands verbatim in the PARENT's prompt, so — like
// every other context-producing tool — it must be bounded: a verbose or runaway
// child (and a parent can fan out `maxParallel` of them in one step) would
// otherwise flood the parent's context window and risk a 400 on the next turn.
// Generous, since a consolidated report is high-value, but capped. The UI still
// gets the full text via the `subagent-finished` event.
const MAX_SUBAGENT_OUTPUT = 32_000;
function capSubagentOutput(s: string): string {
  return s.length > MAX_SUBAGENT_OUTPUT
    ? `${s.slice(0, MAX_SUBAGENT_OUTPUT)}\n…(subagent output truncated at ${MAX_SUBAGENT_OUTPUT} chars; ask it for a more focused subtask if you need the rest)`
    : s;
}

// The real diff handed to a task reviewer also lands in a model's context, so it
// too is bounded — a large refactor's diff would otherwise blow the review turn.
const MAX_REVIEW_DIFF = 20_000;
function capDiff(s: string): string {
  return s.length > MAX_REVIEW_DIFF
    ? `${s.slice(0, MAX_REVIEW_DIFF)}\n…(diff truncated at ${MAX_REVIEW_DIFF} chars)`
    : s;
}

/**
 * The slice of a `Session` the orchestrator machinery depends on. Keeping this
 * explicit (rather than reaching into the whole Session) keeps the runner's
 * coupling to the parent narrow: it reads live mode/goal/depth/model, forks
 * children, emits on the shared bus (via `deps`), and folds a finished child's
 * mutation flag + usage + cost back into the parent through `onChildSettled`.
 */
export interface SessionHandle {
  readonly id: string;
  readonly model: string;
  readonly mode: Mode;
  readonly goal: string | null;
  readonly depth: number;
  readonly deps: SessionDeps;
  /** Fork a child session (a fresh subagent conversation). */
  fork(overrides: Partial<SessionDeps> & { model?: string }): Session;
  /** Fold a settled child's mutation flag + usage + cost up into the parent. */
  onChildSettled(child: Session): void;
}

/**
 * The subagent / task-DAG machinery for a Session: the `spawn_subagent` and
 * `spawn_tasks` tools plus the fork → run → review → retry pipeline behind them.
 * One runner per Session (so the fan-out gate is per-session, matching the
 * original semantics — a parent awaiting its children can't deadlock against a
 * tree-global cap).
 */
export class OrchestratorRunner {
  #handle: SessionHandle;
  /** Bounds how many subagents this session runs concurrently (each fan-out).
   * Per-session, not tree-global, so a parent awaiting its children can't
   * deadlock against the cap. */
  #childGate: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Emit the "review degraded to a generic child" warning at most once per
   * session, not once per verified task. */
  #reviewDegradationWarned = false;
  /** Serializes the commit+merge+remove of every worktree/ensemble task in this
   * runner: concurrent squash-merges into the ONE main tree race `.git/index`
   * (and a merge that touches a file a prior merge already staged is refused by
   * git), so the whole critical section must run one-at-a-time. */
  #mergeLock: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Live-activity tap teardown per child id (see #tapChildActivity): the child
   * runs on an isolated bus, so we subscribe to it and re-emit throttled activity
   * onto the parent bus, then stop when the child finishes. */
  #childTaps = new Map<string, () => void>();

  constructor(handle: SessionHandle) {
    this.#handle = handle;
    this.#childGate = createSemaphore(handle.deps.config.subagent.maxParallel);
    this.#mergeLock = createSerialLock();
    // Tree-shared ledgers: the ROOT runner (where these are absent) creates them
    // on its live deps; forks inherit the SAME objects via `{...deps}`, so the
    // spawn ceiling is tree-global and read_report can see sibling reports.
    if (!handle.deps.spawnCounter) handle.deps.spawnCounter = { used: 0 };
    if (!handle.deps.reportStore) {
      handle.deps.reportStore = new ReportStore(handle.deps.cwd, handle.id);
    }
  }

  /** Build the per-session `spawn_subagent` tool (closes over this session). */
  spawnTool(): ToolDefinition<{
    prompt: string;
    agent?: string;
    mode?: Mode;
  }> {
    const Input = z.object({
      prompt: z
        .string()
        .describe(
          "The complete, self-contained subtask. The subagent sees none of this " +
            "conversation — inline the objective, exact files/paths, and success criteria.",
        ),
      agent: z
        .string()
        .optional()
        .describe("Named agent to specialize the subagent (see the roster in the system prompt)."),
      mode: z.enum(["plan", "execute"]).optional(),
    });
    // NOTE: there is deliberately no `model` parameter. The subagent's model is a
    // user *setting* — `subagent.model` (or a named agent's own `model`), falling
    // back to the parent's model — never something the model picks per call. A
    // model that invented `model:"gpt-4"` here would spawn a child on a provider
    // the user hasn't configured (the Ollama-Cloud "gpt-4 subagent" bug).
    return {
      name: "spawn_subagent",
      description:
        "Delegate a self-contained subtask to a fresh subagent with its own context " +
        "window; it returns only its final answer. Issue several calls in ONE step to " +
        "run them in parallel — give each a disjoint set of files. While you are " +
        "planning (read-only), subagents are read-only too (investigation only).",
      inputSchema: Input,
      // The spawn itself touches nothing — the child's own tools gate their side
      // effects individually — so don't make orchestration prompt for permission.
      readOnly: true,
      concurrencySafe: true,
      execute: async ({ prompt, agent, mode }, ctx) => {
        const check = this.#classifyAgent(agent);
        if (!check.ok) {
          if (check.reason === "unknown") {
            return { output: `Unknown agent "${agent}". Run /agents to list them.`, isError: true };
          }
          // While planning the parent is read-only, so any child is coerced to plan
          // below. A named agent declared for execute (it writes / runs commands)
          // can't do its job under that constraint — coercing it would just burn a
          // turn on a child instructed to edit files it has no tools to touch. The
          // plan-mode roster already hides such agents (only `mode === "plan"` is
          // advertised); reject one named explicitly here too, pointing at the
          // read-only agents the model CAN delegate to. (An explicit `mode:"execute"`
          // request without a named agent is still safely coerced — see #forkChild.)
          const readOnly = [...(this.#handle.deps.agents?.values() ?? [])]
            .filter((a) => a.mode === "plan")
            .map((a) => a.name);
          const suggestion = readOnly.length
            ? ` Use a read-only agent (${readOnly.join(", ")})`
            : " Investigate read-only without a named agent";
          return {
            output:
              `Agent "${agent}" runs in execute mode (it writes or runs commands) ` +
              `and can't run while planning, which is read-only.${suggestion}, or ` +
              `delegate it once you switch to execute mode.`,
            isError: true,
          };
        }
        const named = check.named;
        const child = this.#forkChild(named, mode);
        if (!child) return this.#spawnCeilingError();
        this.#handle.deps.bus.emit({
          type: "subagent-started",
          sessionId: this.#handle.id,
          subagentId: child.id,
          prompt,
        });
        const { timedOut, aborted } = await this.#runChildToCompletion(child, prompt, ctx.abortSignal);
        const outcome = this.#childOutcome(child, timedOut, aborted);
        this.#handle.deps.bus.emit({
          type: "subagent-finished",
          sessionId: this.#handle.id,
          subagentId: child.id,
          result: outcome.event,
        });
        return { output: capSubagentOutput(outcome.text), ...(outcome.isError ? { isError: true } : {}) };
      },
    };
  }

  /**
   * Build the per-session `spawn_tasks` tool: submit a dependency-ordered plan
   * the engine schedules deterministically (the agentswarm Executor pattern).
   */
  spawnTasksTool(): ToolDefinition<{
    tasks: {
      id: string;
      objective: string;
      deps?: string[];
      files?: string[];
      verify?: boolean;
      agent?: string;
      tier?: "cheap" | "strong";
      check?: boolean;
      worktree?: boolean;
      hard?: boolean;
    }[];
  }> {
    const TaskInput = z.object({
      id: z.string().describe("Stable id, referenced by other tasks' `deps`."),
      objective: z
        .string()
        .describe("The complete, self-contained subtask (the subagent sees none of this conversation)."),
      deps: z.array(z.string()).optional().describe("Ids of tasks that must finish before this one starts."),
      files: z.array(z.string()).optional().describe("Files this task owns (give each task a DISJOINT set)."),
      verify: z.boolean().optional().describe("Run a review→retry pass after this task."),
      agent: z.string().optional().describe("Named agent to specialize the subagent."),
      tier: z
        .enum(["cheap", "strong"])
        .optional()
        .describe(
          "Model tier: 'cheap' for scouts / mechanical work, 'strong' for leads / reviewers / verifiers. Resolves to a configured model — you do NOT pick a provider.",
        ),
      check: z
        .boolean()
        .optional()
        .describe("Run the repo's real detected checks (build/typecheck/test) after this task; a red result fails it."),
      worktree: z
        .boolean()
        .optional()
        .describe(
          "Run this task in an isolated git worktree — for parallel writers whose file sets can't be declared disjoint; its changes squash-merge back on success.",
        ),
      hard: z
        .boolean()
        .optional()
        .describe(
          "Run as a best-of-N ensemble in isolated worktrees; expensive, reserve for genuinely hard tasks.",
        ),
    });
    return {
      name: "spawn_tasks",
      description:
        "Submit a whole plan of subtasks as a dependency graph; the engine runs it deterministically — every task whose dependencies are done starts immediately (parallel where possible), dependents unlock as inputs complete, and a task whose dependency failed is skipped. Prefer this over many separate spawn_subagent calls for multi-step work: declare `deps` for ordering, disjoint `files` per task, and `verify:true` on a task to have it reviewed and retried. Each task is a fresh subagent; it returns a consolidated report.",
      inputSchema: z.object({ tasks: z.array(TaskInput).min(1) }),
      readOnly: true,
      concurrencySafe: true,
      execute: async ({ tasks }, ctx) => {
        const specs: TaskSpec[] = tasks.map((t) => ({
          id: t.id,
          objective: t.objective,
          deps: t.deps ?? [],
          ...(t.files ? { files: t.files } : {}),
          ...(t.verify ? { verify: t.verify } : {}),
          ...(t.agent ? { agent: t.agent } : {}),
          ...(t.tier ? { tier: t.tier } : {}),
          ...(t.check ? { check: t.check } : {}),
          ...(t.worktree ? { worktree: t.worktree } : {}),
          ...(t.hard ? { hard: t.hard } : {}),
        }));
        const dagError = validateDag(specs);
        if (dagError) return { output: `Invalid task plan: ${dagError}`, isError: true };
        for (const s of specs) {
          const err = this.#validateAgentForTask(s.agent);
          if (err) return { output: `Task "${s.id}": ${err}`, isError: true };
        }
        // Resume seed: completed tasks from a prior run of THIS session's plan
        // (the journal on disk). runDag honors only ids still in this spec set,
        // so a re-submitted plan re-runs only what didn't finish. Best-effort —
        // a missing/torn journal simply yields no seed.
        const seed = loadCompletedTasks(this.#handle.deps.cwd, this.#handle.id);
        const results = await runDag(
          specs,
          (spec, depResults) => this.#runTask(spec, depResults, ctx.abortSignal),
          {
            onStatus: (spec, status, result) =>
              this.#handle.deps.bus.emit({
                type: "orchestration-task",
                sessionId: this.#handle.id,
                taskId: spec.id,
                objective: spec.objective,
                status,
                ...(result?.attempts !== undefined ? { attempts: result.attempts } : {}),
                ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
              }),
            ...(seed.length ? { seed } : {}),
          },
        );
        return { output: capSubagentOutput(formatTaskResults(results)) };
      },
    };
  }

  /**
   * Classify a named agent against the current mode — the one rule both
   * spawn_subagent and the task orchestrator enforce: an unknown agent is
   * rejected, and an execute-mode agent (it writes / runs commands) can't run
   * while the parent is planning (read-only). Callers render their own message
   * from the verdict (the two surfaces word the rejection differently).
   */
  #classifyAgent(agent: string | undefined):
    | { ok: true; named: NamedAgent | undefined }
    | { ok: false; reason: "unknown" | "execute-in-plan" } {
    if (!agent) return { ok: true, named: undefined };
    const named = this.#handle.deps.agents?.get(agent);
    if (!named) return { ok: false, reason: "unknown" };
    if (this.#handle.mode === "plan" && named.mode !== "plan") {
      return { ok: false, reason: "execute-in-plan" };
    }
    return { ok: true, named };
  }

  /** Validate a task's named agent against the current mode (mirrors spawn_subagent). */
  #validateAgentForTask(agent: string | undefined): string | null {
    const check = this.#classifyAgent(agent);
    if (check.ok) return null;
    if (check.reason === "unknown") return `unknown agent "${agent}". Run /agents to list them.`;
    return `agent "${agent}" runs in execute mode and can't run while planning.`;
  }

  /**
   * Dispatch a task to its execution strategy: a best-of-N ensemble (a `hard`
   * task when `build.ensemble.n > 0` and worktrees are usable), an isolated
   * worktree (a `worktree` task), or the shared tree (the default). Both worktree
   * strategies fall back to the shared tree when git worktrees aren't available —
   * worktree unavailability must never fail a task.
   */
  async #runTask(
    spec: TaskSpec,
    depResults: TaskResult[],
    parentSignal: AbortSignal | undefined,
  ): Promise<TaskResult> {
    const build = this.#handle.deps.config.build;
    if (build.ensemble.n > 0 && spec.hard && build.worktrees.enabled) {
      if (await this.#worktreesUsable()) return this.#runEnsembleTask(spec, depResults, parentSignal);
      // Worktrees can't be created here (a non-git cwd, or an unborn HEAD — a
      // greenfield repo with no commit for `worktree add` to fork off). A hard
      // task must still run: fall back to a single shared-tree attempt rather than
      // hard-failing every ensemble attempt with 'worktree-unavailable'.
      this.#handle.deps.bus.emit({
        type: "notice",
        level: "info",
        message: `Task "${spec.id}": git worktrees unavailable — running the ensemble as a single shared-tree task.`,
      });
      return this.#runSharedTask(spec, depResults, parentSignal);
    }
    if (spec.worktree && build.worktrees.enabled) {
      // #runWorktreeTask itself falls back to the shared tree if the worktree
      // can't be created (e.g. a non-git cwd), so no pre-check is needed here.
      return this.#runWorktreeTask(spec, depResults, parentSignal);
    }
    return this.#runSharedTask(spec, depResults, parentSignal);
  }

  /** Whether git worktrees can actually be created in the session cwd. Requires a
   * real work tree AND a born HEAD: `git worktree add … HEAD` forks off HEAD, so
   * an unborn HEAD (a repo with no commit yet) fails even though it IS inside a
   * work tree — the old `is-inside-work-tree`-only check mis-reported it usable. */
  async #worktreesUsable(): Promise<boolean> {
    try {
      const repo = await spawnGit(this.#handle.deps.cwd, ["rev-parse", "--is-inside-work-tree"]);
      if (!(repo.ok && /true/.test(repo.stdout))) return false;
      const head = await spawnGit(this.#handle.deps.cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
      return head.ok && !!head.stdout.trim();
    } catch {
      return false;
    }
  }

  /** The current HEAD sha of a tree (the base each worktree attempt forks from,
   * used as the diff-size tiebreak ref for the ensemble). */
  async #headRef(cwd: string): Promise<string> {
    const r = await spawnGit(cwd, ["rev-parse", "HEAD"]);
    return r.ok ? r.stdout.trim() || "HEAD" : "HEAD";
  }

  /**
   * Run a task in an isolated git worktree. The child's tools redirect to the
   * worktree (via the fork's cwd), so parallel worktree writers touching the same
   * relative path never collide. On success the worktree's work is committed then
   * squash-merged back into the main tree, and the gate/review run on the MERGED
   * main tree (that state is what matters). A conflicting merge fails the task.
   *
   * There is deliberately no in-worktree verify→retry loop: the worktree is
   * squash-merged and removed once the child settles, so a red post-merge gate
   * fails the task to be re-planned rather than retried against a discarded tree.
   */
  async #runWorktreeTask(
    spec: TaskSpec,
    depResults: TaskResult[],
    parentSignal: AbortSignal | undefined,
  ): Promise<TaskResult> {
    const mainCwd = this.#handle.deps.cwd;
    const slug = worktreeSlug(spec.id);
    const wtPath = join(mainCwd, ".vibe", "worktrees", slug);
    const branch = worktreeBranch(this.#handle.id, slug);
    const wt = await gitAddWorktree(mainCwd, { path: wtPath, branch });
    if (!wt) {
      // Never fail a task over worktree unavailability — run it in the shared
      // tree instead (the journal note the caller asked for, surfaced as a notice
      // since the append-only journal only carries task-started/finished events).
      this.#handle.deps.bus.emit({
        type: "notice",
        level: "info",
        message: `Task "${spec.id}": git worktree unavailable — running in the shared tree.`,
      });
      return this.#runSharedTask(spec, depResults, parentSignal);
    }

    const named = spec.agent ? this.#handle.deps.agents?.get(spec.agent) : undefined;
    const profile = this.#handle.deps.repoProfile;
    const wantsGate = (spec.check || spec.verify) && !!profile;
    const startedAt = Date.now();
    this.#journal({
      type: "task-started",
      at: startedAt,
      id: spec.id,
      objective: spec.objective,
      deps: spec.deps,
      worktree: true,
      ...(spec.tier ? { tier: spec.tier } : {}),
    });
    const settle = (partial: Omit<TaskResult, "durationMs">): TaskResult => {
      const result: TaskResult = { ...partial, durationMs: Date.now() - startedAt };
      this.#recordFinished(spec, result);
      return result;
    };

    try {
      const child = this.#forkChild(named, undefined, spec.tier, wt);
      if (!child) {
        return settle({ id: spec.id, objective: spec.objective, outcome: "failed", output: this.#spawnCeilingError().output, attempts: 1 });
      }
      this.#handle.deps.bus.emit({ type: "subagent-started", sessionId: this.#handle.id, subagentId: child.id, prompt: spec.objective });
      const { timedOut, aborted } = await this.#runChildToCompletion(child, buildTaskKickoff(spec, depResults, ""), parentSignal);
      const outcome = this.#childOutcome(child, timedOut, aborted);
      this.#handle.deps.bus.emit({ type: "subagent-finished", sessionId: this.#handle.id, subagentId: child.id, result: outcome.event });
      if (outcome.isError) {
        return settle({ id: spec.id, objective: spec.objective, outcome: "failed", output: outcome.text, attempts: 1 });
      }
      const handoff = parseHandoff(outcome.text) ?? undefined;

      // Commit → squash-merge → gate → review, ALL inside ONE critical section.
      // The gate/review build+test the whole MAIN tree, so a sibling worktree
      // task's merge landing between this task's merge and its own gate would give
      // it a nondeterministic verdict (and two builds clobbering one dir). Holding
      // the merge lock across the verify phase keeps the main tree stable for this
      // task's gate. Deadlock-free: a review child acquires the (separate) fan-out
      // semaphore, and siblings release their fan-out slots before they ever queue
      // on this lock. The worktree removal runs in the outer finally, also serialized.
      const verdict = await this.#mergeLock(
        async (): Promise<{ ok: true } | { ok: false; output: string }> => {
          await commitWorktree(wt, `vibecodr(task ${spec.id}): ${spec.objective}`);
          if (!(await gitMergeWorktreeBranch(mainCwd, branch))) {
            return { ok: false, output: "merge conflict — changes discarded; re-plan with disjoint files or sequential deps" };
          }
          if (wantsGate) {
            const gate = await runGate(mainCwd, profile!, 0, {
              checks: this.#handle.deps.config.build.gate.checks,
              timeoutSec: this.#handle.deps.config.build.gate.timeoutSec,
              ...(parentSignal ? { signal: parentSignal } : {}),
            });
            if (gate.outcome === "red") {
              return { ok: false, output: `Checks failed on the merged tree:\n${formatGateFailure(gate, 1)}` };
            }
          }
          if (spec.verify) {
            const review = await this.#reviewTask(spec, outcome.text, parentSignal);
            if (!review.clean) return { ok: false, output: `Post-merge review found issues:\n${review.feedback}` };
          }
          return { ok: true };
        },
      );
      if (!verdict.ok) {
        return settle({ id: spec.id, objective: spec.objective, outcome: "failed", output: verdict.output, attempts: 1, ...(handoff ? { handoff } : {}) });
      }
      return settle({ id: spec.id, objective: spec.objective, outcome: "completed", output: outcome.text, attempts: 1, ...(handoff ? { handoff } : {}) });
    } catch (err) {
      return settle({ id: spec.id, objective: spec.objective, outcome: "failed", output: `Worktree task threw: ${(err as Error)?.message ?? String(err)}`, attempts: 1 });
    } finally {
      // Always tear down the worktree — the happy path AND every early return/throw
      // after gitAddWorktree created it (spawn-ceiling, child error/interrupt, a
      // thrown exception). Without this an early return leaks the worktree + its
      // branch, and a later re-run of the same id can't recreate the branch (so it
      // silently loses worktree isolation). Serialized behind the merge lock so
      // removal can't race a sibling's squash-merge on the shared .git.
      await this.#mergeLock(() => gitRemoveWorktree(mainCwd, wt, branch)).catch(() => {});
    }
  }

  /**
   * Best-of-N ensemble: run N attempts of the SAME objective in N isolated
   * worktrees, each nudged toward a distinct strategy, then judge OBJECTIVELY —
   * commit each attempt and run the repo's real gate INSIDE its worktree
   * (green=2 / unverified=1 / red=0; no-change=-1; tiebreak = smaller diff). Only
   * the winner (score > 0) squash-merges into the main tree; every other worktree
   * + branch is discarded. Each attempt's usage folds into the parent via the
   * per-child #runChildToCompletion path.
   */
  async #runEnsembleTask(
    spec: TaskSpec,
    depResults: TaskResult[],
    parentSignal: AbortSignal | undefined,
  ): Promise<TaskResult> {
    const mainCwd = this.#handle.deps.cwd;
    const n = Math.min(this.#handle.deps.config.build.ensemble.n, ENSEMBLE_STRATEGIES.length);
    const startedAt = Date.now();
    this.#journal({
      type: "task-started",
      at: startedAt,
      id: spec.id,
      objective: spec.objective,
      deps: spec.deps,
      worktree: true,
      ...(spec.tier ? { tier: spec.tier } : {}),
    });
    const settle = (partial: Omit<TaskResult, "durationMs">): TaskResult => {
      const result: TaskResult = { ...partial, durationMs: Date.now() - startedAt };
      this.#recordFinished(spec, result);
      return result;
    };
    const baseRef = await this.#headRef(mainCwd);

    const attempts = await Promise.all(
      Array.from({ length: n }, (_, i) => i).map((i) => this.#runEnsembleAttempt(spec, depResults, parentSignal, i, baseRef)),
    );

    // Safety net: if NO attempt could even create a worktree (born HEAD passed the
    // pre-check but `worktree add` still failed for every attempt), never fail a
    // hard task over it — fall back to a single shared-tree attempt. No child ran
    // for a worktree-unavailable attempt, so this wastes no model calls.
    if (attempts.every((a) => a.wt === null)) {
      this.#handle.deps.bus.emit({
        type: "notice",
        level: "info",
        message: `Task "${spec.id}": no ensemble worktree could be created — running in the shared tree.`,
      });
      return this.#runSharedTask(spec, depResults, parentSignal);
    }

    // Winner: highest score, ties broken by the smaller diff. Must score > 0.
    const winner = [...attempts]
      .filter((a) => a.score > 0)
      .sort((x, y) => y.score - x.score || x.diffSize - y.diffSize)[0];

    try {
      if (!winner) {
        const summary = attempts
          .map((a) => `- attempt ${a.i} (${a.label}): ${a.verdict}`)
          .join("\n");
        return settle({
          id: spec.id,
          objective: spec.objective,
          outcome: "failed",
          output: `Best-of-${n} ensemble: no attempt passed the gate.\n${summary}`,
          attempts: n,
        });
      }
      const merged = await this.#mergeLock(() => gitMergeWorktreeBranch(mainCwd, winner.branch));
      if (!merged) {
        return settle({
          id: spec.id,
          objective: spec.objective,
          outcome: "failed",
          output: "merge conflict — changes discarded; re-plan with disjoint files or sequential deps",
          attempts: n,
          ...(winner.handoff ? { handoff: winner.handoff } : {}),
        });
      }
      return settle({
        id: spec.id,
        objective: spec.objective,
        outcome: "completed",
        output: winner.text,
        attempts: n,
        ...(winner.handoff ? { handoff: winner.handoff } : {}),
      });
    } finally {
      // Discard EVERY attempt's worktree + branch (the winner's merge is done, so
      // its branch is now redundant; losers are thrown away). Serialized so a
      // removal can't race a merge on the shared .git.
      for (const a of attempts) {
        if (a.wt) await this.#mergeLock(() => gitRemoveWorktree(mainCwd, a.wtPath, a.branch));
      }
    }
  }

  /** One ensemble attempt: fork a child in its own worktree with a strategy
   * directive, commit its work, and score it by the in-worktree gate. */
  async #runEnsembleAttempt(
    spec: TaskSpec,
    depResults: TaskResult[],
    parentSignal: AbortSignal | undefined,
    i: number,
    baseRef: string,
  ): Promise<EnsembleAttempt> {
    const mainCwd = this.#handle.deps.cwd;
    const profile = this.#handle.deps.repoProfile;
    const named = spec.agent ? this.#handle.deps.agents?.get(spec.agent) : undefined;
    const strategy = ENSEMBLE_STRATEGIES[i]!;
    const label = strategy.name;
    const wtId = `${worktreeSlug(spec.id)}-a${i}`;
    const wtPath = join(mainCwd, ".vibe", "worktrees", wtId);
    const branch = worktreeBranch(this.#handle.id, wtId);
    const base: EnsembleAttempt = { i, label, wt: null, wtPath, branch, text: "", score: -1, diffSize: Infinity, verdict: "not-run" };

    const wt = await gitAddWorktree(mainCwd, { path: wtPath, branch });
    if (!wt) return { ...base, verdict: "worktree-unavailable" };
    const child = this.#forkChild(named, undefined, spec.tier, wt);
    if (!child) return { ...base, wt, verdict: "spawn-ceiling" };
    this.#handle.deps.bus.emit({ type: "subagent-started", sessionId: this.#handle.id, subagentId: child.id, prompt: spec.objective });
    const kickoff = `${buildTaskKickoff(spec, depResults, "")}\n\n${strategy.directive}`;
    const { timedOut, aborted } = await this.#runChildToCompletion(child, kickoff, parentSignal);
    const outcome = this.#childOutcome(child, timedOut, aborted);
    this.#handle.deps.bus.emit({ type: "subagent-finished", sessionId: this.#handle.id, subagentId: child.id, result: outcome.event });
    const handoff = parseHandoff(outcome.text) ?? undefined;
    if (outcome.isError) return { ...base, wt, text: outcome.text, ...(handoff ? { handoff } : {}), verdict: "child-error" };

    // Commit so the branch carries the work (squash-merge sees only commits) and
    // the in-worktree gate judges the committed state.
    const committed = await commitWorktree(wt, `vibecodr(ensemble ${spec.id} a${i}): ${spec.objective}`);
    if (!committed) return { ...base, wt, text: outcome.text, ...(handoff ? { handoff } : {}), score: -1, verdict: "no-changes" };

    const diffSize = (await gitDiffSince(wt, baseRef)).length;
    let score = 1;
    let verdict = "unverified";
    if (profile) {
      const gate = await runGate(wt, profile, 0, {
        checks: this.#handle.deps.config.build.gate.checks,
        timeoutSec: this.#handle.deps.config.build.gate.timeoutSec,
        ...(parentSignal ? { signal: parentSignal } : {}),
      });
      score = gate.outcome === "green" ? 2 : gate.outcome === "red" ? 0 : 1;
      verdict = gate.outcome;
    }
    return { ...base, wt, text: outcome.text, ...(handoff ? { handoff } : {}), score, diffSize, verdict };
  }

  /** Run one orchestrator task in the SHARED tree: fork a subagent, thread in
   * dependency results + coordination, then (when `check`/`verify`) run the
   * repo's REAL checks and an adversarial diff review, retrying up to
   * verifyMaxAttempts. */
  async #runSharedTask(
    spec: TaskSpec,
    depResults: TaskResult[],
    parentSignal: AbortSignal | undefined,
  ): Promise<TaskResult> {
    const named = spec.agent ? this.#handle.deps.agents?.get(spec.agent) : undefined;
    const maxAttempts = spec.verify ? Math.max(1, this.#handle.deps.config.subagent.verifyMaxAttempts) : 1;
    const profile = this.#handle.deps.repoProfile;
    // Both `check:true` and `verify:true` run the real green-gate FIRST when a
    // profile exists — a red tree fails the attempt on machine truth without
    // spending an LLM review call. `verify` additionally gets the diff review.
    const wantsGate = (spec.check || spec.verify) && !!profile;
    const startedAt = Date.now();
    // Journal the task's start (best-effort — journaling never fails a run).
    this.#journal({
      type: "task-started",
      at: startedAt,
      id: spec.id,
      objective: spec.objective,
      deps: spec.deps,
      ...(spec.tier ? { tier: spec.tier } : {}),
    });

    let feedback = "";
    let attempts = 0;
    let handoff: Handoff | undefined;
    // Every terminal path records the report (store + persist + journal) and
    // stamps the wall-clock so the UIEvent + journal carry it.
    const settle = (partial: Omit<TaskResult, "durationMs">): TaskResult => {
      const result: TaskResult = { ...partial, durationMs: Date.now() - startedAt };
      this.#recordFinished(spec, result);
      return result;
    };

    while (attempts < maxAttempts) {
      attempts++;
      const child = this.#forkChild(named, undefined, spec.tier);
      if (!child) {
        return settle({
          id: spec.id,
          objective: spec.objective,
          outcome: "failed",
          output: this.#spawnCeilingError().output,
          attempts,
        });
      }
      this.#handle.deps.bus.emit({
        type: "subagent-started",
        sessionId: this.#handle.id,
        subagentId: child.id,
        prompt: spec.objective,
      });
      const { timedOut, aborted } = await this.#runChildToCompletion(
        child,
        buildTaskKickoff(spec, depResults, feedback),
        parentSignal,
      );
      const outcome = this.#childOutcome(child, timedOut, aborted);
      this.#handle.deps.bus.emit({
        type: "subagent-finished",
        sessionId: this.#handle.id,
        subagentId: child.id,
        result: outcome.event,
      });
      if (outcome.isError) {
        return settle({ id: spec.id, objective: spec.objective, outcome: "failed", output: outcome.text, attempts });
      }
      // The structured handoff (if the child emitted one) rides to dependents
      // verbatim; the full prose is pull-only via read_report.
      handoff = parseHandoff(outcome.text) ?? undefined;

      // Executable verify: run the real checks BEFORE any LLM review. A red gate
      // is machine truth — fail the attempt with the structured, actionable gate
      // output as the retry feedback, without burning a review call.
      if (wantsGate) {
        const gate = await runGate(this.#handle.deps.cwd, profile!, attempts - 1, {
          checks: this.#handle.deps.config.build.gate.checks,
          timeoutSec: this.#handle.deps.config.build.gate.timeoutSec,
          ...(parentSignal ? { signal: parentSignal } : {}),
        });
        if (gate.outcome === "red") {
          feedback = formatGateFailure(gate, maxAttempts);
          if (attempts < maxAttempts) continue; // retry with the failing checks
          return settle({
            id: spec.id,
            objective: spec.objective,
            outcome: "failed",
            output: `Checks failed after ${attempts} attempt(s):\n${feedback}`,
            attempts,
            ...(handoff ? { handoff } : {}),
          });
        }
        // green or unverified → fall through to the diff review (for verify).
      }

      // A task that did nothing on its FIRST attempt has nothing to verify → done.
      // But on a RETRY (feedback set), a non-mutating child leaves the previous
      // attempt's REJECTED edits on disk — don't short-circuit to "completed" and
      // drop the reviewer's feedback; fall through to re-review so outstanding
      // issues still gate completion.
      if (!spec.verify || (!child.didMutate && !feedback)) {
        return settle({
          id: spec.id,
          objective: spec.objective,
          outcome: "completed",
          output: outcome.text,
          attempts,
          ...(handoff ? { handoff } : {}),
        });
      }
      const review = await this.#reviewTask(spec, outcome.text, parentSignal);
      if (review.clean) {
        return settle({
          id: spec.id,
          objective: spec.objective,
          outcome: "completed",
          output: outcome.text,
          attempts,
          ...(handoff ? { handoff } : {}),
        });
      }
      feedback = review.feedback;
    }
    return settle({
      id: spec.id,
      objective: spec.objective,
      outcome: "failed",
      output: `Verification still failing after ${attempts} attempt(s):\n${feedback}`,
      attempts,
      ...(handoff ? { handoff } : {}),
    });
  }

  /** The isError result returned when the tree hits its subagent budget. Shared
   * so spawn_subagent and the task path word it identically. */
  #spawnCeilingError(): { output: string; isError: true } {
    const max = this.#handle.deps.config.subagent.maxTotal;
    return {
      output:
        `Subagent budget exhausted: this session tree has already spawned its ceiling of ${max} ` +
        "subagents (subagent.maxTotal). Do the remaining work directly, or narrow the plan — no more " +
        "children can be spawned this run.",
      isError: true,
    };
  }

  /**
   * Adversarial diff review of a finished task's work. The reviewer sees the REAL
   * unstaged diff of the task's declared files (not the child's self-report) plus
   * advisory stub-scan findings, and defaults to the `strong` tier when a `review`
   * agent isn't configured. Emits a one-time degradation notice in that case.
   */
  async #reviewTask(
    spec: TaskSpec,
    work: string,
    parentSignal: AbortSignal | undefined,
  ): Promise<{ clean: boolean; feedback: string }> {
    const reviewAgent = this.#handle.deps.agents?.get("review");
    if (!reviewAgent && !this.#reviewDegradationWarned) {
      // LOUD once-per-session: a generic read-only child is a weaker reviewer than
      // a purpose-built `review` agent, and silent degradation hides that.
      this.#reviewDegradationWarned = true;
      this.#handle.deps.bus.emit({
        type: "notice",
        level: "warn",
        message:
          "No 'review' agent is configured — task verification is degraded to a generic read-only " +
          "reviewer. Add a `review` agent for higher-quality diff review.",
      });
    }
    const diff = await this.#captureTaskDiff(spec);
    const stubBlock =
      this.#handle.deps.config.build.review.stubScan && diff
        ? formatStubFindings(scanStubs(diff))
        : "";
    // Read-only reviewer; prefer the strong tier when the user configured one.
    const child = this.#forkChild(reviewAgent, "plan", "strong");
    if (!child) {
      // No reviewer could be spawned (budget) — do NOT pass it as clean; surface
      // the reason as feedback so the task fails rather than ships unreviewed.
      return { clean: false, feedback: this.#spawnCeilingError().output };
    }
    const prompt =
      `Review the work done for this task. Objective: ${spec.objective}\n` +
      (spec.files?.length ? `Files: ${spec.files.join(", ")}\n` : "") +
      `\nThe agent reported:\n${work}\n\n` +
      "The ACTUAL diff of the task's changes (authoritative — review THIS, not the report above):\n" +
      "```diff\n" +
      (diff ? capDiff(diff) : "(no textual diff — the task may have made no on-disk changes)") +
      "\n```\n" +
      (stubBlock
        ? `\nDeterministic stub-scan flagged these ADDED lines (advisory — verify each, some are false positives):\n${stubBlock}\n`
        : "") +
      "\nVerify against the diff and the files. Report concrete issues as `path:line — problem`, " +
      "or reply exactly REVIEW-CLEAN if the work is correct and complete.";
    await this.#runChildToCompletion(child, prompt, parentSignal);
    const out = child.lastAssistantText();
    return { clean: isReviewClean(out), feedback: out || "(reviewer produced no output)" };
  }

  /** Capture the task's diff vs HEAD, scoped to its declared files (unscoped when
   * it declared none). Diffing against HEAD (not the bare unstaged `git diff`)
   * covers BOTH a shared-tree task (whose edits are unstaged) AND a worktree task
   * whose squash-merge STAGED its changes — a plain `git diff` would show an empty
   * diff for the latter. Falls back to the unstaged diff on an unborn HEAD (a
   * greenfield repo with no commit yet). Best-effort — on a git error, returns "". */
  async #captureTaskDiff(spec: TaskSpec): Promise<string> {
    const scope = spec.files?.length ? ["--", ...spec.files] : [];
    try {
      const r = await spawnGit(this.#handle.deps.cwd, ["diff", "HEAD", ...scope]);
      if (r.ok) return r.stdout;
      // Unborn HEAD (no commit yet) → fall back to the unstaged working diff.
      const bare = await spawnGit(this.#handle.deps.cwd, ["diff", ...scope]);
      return bare.ok ? bare.stdout : "";
    } catch {
      return "";
    }
  }

  /** Append an orchestration-journal event (best-effort — never fails a run). */
  #journal(event: Parameters<typeof appendOrchestrationEvent>[2]): void {
    try {
      appendOrchestrationEvent(this.#handle.deps.cwd, this.#handle.id, event);
    } catch {
      /* journaling is best-effort */
    }
  }

  /** Record a settled task: fill the in-memory report store, persist the full
   * report for a completed task (so read_report survives resume), and journal the
   * finish with its report path. All best-effort. */
  #recordFinished(spec: TaskSpec, result: TaskResult): void {
    this.#handle.deps.reportStore?.set(spec.id, { objective: spec.objective, output: result.output });
    let reportPath: string | undefined;
    if (result.outcome === "completed") {
      reportPath = persistTaskReport(this.#handle.deps.cwd, this.#handle.id, spec.id, result.output);
    }
    this.#journal({
      type: "task-finished",
      at: Date.now(),
      id: spec.id,
      objective: spec.objective,
      outcome: result.outcome,
      attempts: result.attempts,
      ...(result.handoff ? { handoff: result.handoff } : {}),
      ...(reportPath ? { reportPath } : {}),
    });
  }

  /**
   * Fork a subagent child for delegated work (shared by spawn_subagent and the
   * orchestrator). Resolves the named agent's mode/model/system and coerces the
   * child to plan mode when the parent is planning. Returns null when the tree
   * has hit its `subagent.maxTotal` spawn ceiling (the caller surfaces an error
   * to the model instead of throwing).
   *
   * The model is a *setting* — never model-chosen per call. Resolution chain:
   * named-agent model → `tier` model (a CONFIG string in build.models) →
   * subagent.model → the parent's model. A `tier` NEVER injects a
   * model-invented provider; it only reads config, so the Ollama-Cloud "gpt-4
   * subagent" class of bug can't recur through it.
   */
  #forkChild(
    named: NamedAgent | undefined,
    requestedMode: Mode | undefined,
    tier?: TaskSpec["tier"],
    cwdOverride?: string,
  ): Session | null {
    // Tree-global spawn ceiling: fail closed at the cap rather than let a runaway
    // model fan out forever (cost was previously the only backstop).
    const counter = this.#handle.deps.spawnCounter;
    if (counter && counter.used >= this.#handle.deps.config.subagent.maxTotal) return null;
    if (counter) counter.used++;

    const childMode: Mode =
      this.#handle.mode === "plan" ? "plan" : (requestedMode ?? named?.mode ?? "execute");
    // Kickoff context injected into every child: the named agent's own system
    // block, plus the repo symbol map (engine-built, mtime-cached) so a fresh
    // child orients on the codebase's structure without re-deriving it — the
    // single cheapest way to stop children reinventing helpers/breaking callers.
    const extraSystem: string[] = [];
    if (named?.system) extraSystem.push(named.system);
    if (this.#handle.deps.repoMap) {
      extraSystem.push(
        `REPO SYMBOL MAP (files ranked by how load-bearing they are; top-level declarations):\n${this.#handle.deps.repoMap}`,
      );
    }
    const tierModel = tier ? this.#handle.deps.config.build.models[tier] : undefined;
    // The child streams onto its OWN bus (isolated from the parent's UI); we tap
    // it below to surface live activity.
    const childBus = new EventBusImpl();
    const child = this.#handle.fork({
      bus: childBus,
      model: named?.model ?? tierModel ?? this.#handle.deps.config.subagent.model ?? this.#handle.model,
      mode: childMode,
      goal: this.#handle.goal,
      depth: this.#handle.depth + 1,
      // A worktree/ensemble task redirects the child's whole toolset to its
      // isolated tree by overriding the fork's cwd (SessionDeps.cwd → every tool).
      ...(cwdOverride ? { cwd: cwdOverride } : {}),
      ...(extraSystem.length ? { extraSystem } : {}),
      // A named agent's tool allowlist/denylist restricts the child's tools.
      ...(named?.tools || named?.denyTools
        ? { toolFilter: { ...(named.tools ? { allow: named.tools } : {}), ...(named.denyTools ? { deny: named.denyTools } : {}) } }
        : {}),
    });
    this.#tapChildActivity(child.id, childBus);
    return child;
  }

  /**
   * Live child activity: the child runs on an isolated bus, so subscribe to it
   * and re-emit a compact one-line `subagent-activity` onto the PARENT bus for
   * each tool-call-started / file-changed — so a minutes-long fan-out shows what
   * each child is doing right now, not just started/finished. Throttled to one
   * emit per 250ms per child (intermediate events are dropped, not queued), and
   * torn down by #runChildToCompletion when the child finishes.
   */
  #tapChildActivity(childId: string, childBus: EventBusImpl): void {
    const sub = childBus.subscribe();
    let lastEmit = 0;
    // Consume the child's stream; ends when the bus closes (stop() below).
    void (async () => {
      for await (const e of sub) {
        let label: string | undefined;
        if (e.type === "tool-call-started") label = activityLabel(e.toolName, e.input);
        else if (e.type === "file-changed") label = `✎ ${e.path}`;
        if (label === undefined) continue;
        const now = Date.now();
        if (now - lastEmit < ACTIVITY_THROTTLE_MS) continue; // drop intermediate
        lastEmit = now;
        this.#handle.deps.bus.emit({
          type: "subagent-activity",
          sessionId: this.#handle.id,
          subagentId: childId,
          label,
        });
      }
    })();
    // Closing the child bus drains any buffered events then ends the loop above.
    this.#childTaps.set(childId, () => childBus.close());
  }

  /**
   * Run a forked child to completion through the fan-out gate + per-subagent
   * wall-clock timeout, propagating a parent abort and folding the child's
   * usage/cost up into this session. Returns whether the timeout fired.
   */
  async #runChildToCompletion(
    child: Session,
    prompt: string,
    parentSignal: AbortSignal | undefined,
  ): Promise<{ timedOut: boolean; aborted: boolean }> {
    const onAbort = () => child.abort();
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    try {
      // Bound concurrent fan-out: at most `subagent.maxParallel` children run at
      // once; extras queue. Parallel calls in one step share this gate.
      await this.#childGate(() => {
        // If the user aborted while this child was still queued, don't burn a
        // model call — the parent turn is already unwinding.
        if (parentSignal?.aborted) return Promise.resolve();
        // Wall-clock guard: a hung provider stream can't wedge the gate forever.
        const timeoutMs = this.#handle.deps.config.subagent.timeoutMs;
        if (!timeoutMs) return child.run(prompt);
        const timer = setTimeout(() => {
          timedOut = true;
          child.abort();
        }, timeoutMs);
        return child.run(prompt).finally(() => clearTimeout(timer));
      });
    } finally {
      parentSignal?.removeEventListener("abort", onAbort);
      // Stop the live-activity tap now the child has finished emitting (closes its
      // isolated bus, which drains any buffered events then ends the tap loop).
      const stopTap = this.#childTaps.get(child.id);
      if (stopTap) {
        this.#childTaps.delete(child.id);
        stopTap();
      }
    }
    // Fold the child's mutation flag + tokens + cost into the parent (the child
    // runs on an isolated bus), so auto-verify, `/cost`, and the spend guard all
    // account for delegated work.
    this.#handle.onChildSettled(child);
    // A parent abort that landed while this child was queued (the gate short-
    // circuit above) means the child never ran — surface it so #childOutcome
    // treats the task as interrupted, not a clean (empty) completion.
    return { timedOut, aborted: parentSignal?.aborted === true };
  }

  /** Normalize a finished child into a model-facing text + error flag + a short
   * event label, salvaging any partial output on timeout/failure. */
  #childOutcome(
    child: Session,
    timedOut: boolean,
    aborted = false,
  ): { text: string; isError: boolean; event: string } {
    const partial = child.lastAssistantText();
    if (timedOut) {
      const secs = Math.round(this.#handle.deps.config.subagent.timeoutMs / 1000);
      return {
        text:
          `Subagent timed out after ${secs}s and was stopped.` +
          (partial ? `\n\nPartial output before timeout:\n${partial}` : ""),
        isError: true,
        event: `timed out after ${secs}s`,
      };
    }
    // An interrupted child (Esc / steer aborted it, or it was aborted before it
    // ever ran because the parent turn was already unwinding) is NOT a clean
    // completion: its output is partial. Session marks a cancel as `interrupted`
    // (not `lastError`), so without this the outcome would fall through to
    // isError:false — and a task would be journaled "completed" and, for a
    // worktree task, its PARTIAL edits committed + squash-merged into the main
    // tree. Fail it instead so it re-runs on resume rather than silently losing work.
    if (child.interrupted || aborted) {
      return {
        text: partial
          ? `Subagent was interrupted before completing.\n\nPartial output before interruption:\n${partial}`
          : "Subagent was interrupted before completing (no output produced).",
        isError: true,
        event: "interrupted",
      };
    }
    if (child.lastError) {
      return {
        text: partial
          ? `Subagent failed: ${child.lastError}\n\nPartial output before failure:\n${partial}`
          : `Subagent failed: ${child.lastError}`,
        isError: true,
        event: `failed: ${child.lastError}`,
      };
    }
    const text =
      partial ||
      (child.didMutate
        ? "(subagent completed via tool calls but produced no written summary)"
        : "(subagent produced no output)");
    return { text, isError: false, event: text };
  }
}

/** Compose the self-contained kickoff prompt for an orchestrator task: the
 * objective, owned files, prerequisite handoffs, coordination reminder, the
 * handoff-block instruction, and (on a verify retry) the reviewer's feedback. */
function buildTaskKickoff(spec: TaskSpec, depResults: TaskResult[], feedback: string): string {
  const parts: string[] = [spec.objective];
  if (spec.files?.length) {
    parts.push(
      // Honest lock semantics: the claim registry rejects CONCURRENT writes while
      // another task holds a file; a later task can still touch a file an earlier,
      // already-finished task owned. So the guidance is disjointness, not a myth
      // that any shared path is hard-rejected regardless of timing.
      `Files you own (edit only these; while another task concurrently holds a file the engine rejects your write to it, so keep to your set): ${spec.files.join(", ")}`,
    );
  }
  if (depResults.length) {
    // Prefer the dependency's STRUCTURED handoff (its load-bearing facts,
    // verbatim) over a blind prose slice; either way point at read_report for the
    // full write-up so a dependent can pull detail on demand instead of drowning
    // in it by default.
    const summaries = depResults
      .map((d) =>
        d.handoff
          ? formatHandoffForKickoff(d.id, d.handoff)
          : `- [${d.id}] ${d.output.replace(/\s+/g, " ").trim().slice(0, 1_000)}\n  (full report: read_report("${d.id}"))`,
      )
      .join("\n");
    parts.push(`Results from the prerequisite tasks you depend on:\n${summaries}`);
  }
  parts.push(
    "You're one task in a coordinated plan. Use read_notes/post_note to see and share decisions with sibling tasks. Be self-contained, then report what you did and any follow-ups. Done only when the objective is fully met.",
  );
  if (feedback) {
    parts.push(`A previous attempt was reviewed and needs fixing before this is acceptable:\n${feedback}`);
  }
  parts.push(HANDOFF_INSTRUCTION);
  return parts.join("\n\n");
}

/**
 * Whether a task reviewer's output is a CLEAN verdict. Requires `REVIEW-CLEAN` as
 * its own verdict at the start of a line — NOT a bare substring — so an
 * adversarial reviewer that writes "NOT REVIEW-CLEAN — path:line — problem" (or
 * "this is not REVIEW-CLEAN") is treated as feedback, not a pass whose concrete
 * issues get silently discarded. Biased to a re-review (false negative) over
 * shipping rejected work (false positive).
 */
export function isReviewClean(out: string): boolean {
  return /(^|\n)\s*REVIEW-CLEAN\b/.test(out);
}

/** One best-of-N ensemble attempt's outcome (see #runEnsembleAttempt). */
interface EnsembleAttempt {
  i: number;
  /** Short strategy name (for the no-winner summary). */
  label: string;
  /** The created worktree path, or null when it couldn't be created. */
  wt: string | null;
  wtPath: string;
  branch: string;
  /** The child's final report (the winner's becomes the task output). */
  text: string;
  handoff?: Handoff;
  /** green=2 / unverified=1 / red=0 / no-change (or failed to run)=-1. */
  score: number;
  /** Changed-file count vs the fork base — the smaller-diff tiebreak. */
  diffSize: number;
  /** Human-readable gate/failure verdict for the no-winner summary. */
  verdict: string;
}

/** Best-of-N ensemble strategies (ported from agentswarm): each attempt gets a
 * distinct directive appended to its kickoff so N children explore genuinely
 * different approaches rather than N near-identical ones. */
const ENSEMBLE_STRATEGIES: { name: string; directive: string }[] = [
  { name: "minimal-diff", directive: "Strategy directive: take a MINIMAL-DIFF approach — the smallest, most surgical change that fully satisfies the objective; touch as few lines as possible." },
  { name: "test-first", directive: "Strategy directive: take a TEST-FIRST approach — pin the desired behavior with tests first, then implement until they pass." },
  { name: "library-first", directive: "Strategy directive: take a LIBRARY-FIRST approach — prefer an existing dependency or stdlib primitive over hand-rolled code; reuse before you build." },
  { name: "first-principles", directive: "Strategy directive: take a FROM-FIRST-PRINCIPLES approach — derive the cleanest design directly from the requirements rather than the obvious patch." },
  { name: "defensive", directive: "Strategy directive: take a DEFENSIVE approach — prioritize edge cases, input validation, and clear error handling." },
];

/** At most one live-activity emit per child per this interval (drop intermediate). */
const ACTIVITY_THROTTLE_MS = 250;
const MAX_ACTIVITY_LABEL = 80;

/** A compact one-line label for a child's tool call: "$ <cmd head>" for bash,
 * "edit/read/write <path>" for the file tools, else the bare tool name. */
function activityLabel(toolName: string, input: unknown): string {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  let label: string;
  if (toolName === "bash" && typeof inp.command === "string") {
    label = `$ ${inp.command.split("\n")[0]?.trim() ?? ""}`;
  } else if (typeof inp.path === "string" && (toolName === "edit" || toolName === "read" || toolName === "write")) {
    label = `${toolName} ${inp.path}`;
  } else {
    label = toolName;
  }
  return label.length > MAX_ACTIVITY_LABEL ? label.slice(0, MAX_ACTIVITY_LABEL) : label;
}

/** Filesystem-safe worktree id fragment (matches the journal's own sanitizer). */
function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64);
}

/** A short stable hash of the FULL raw id — appended to the sanitized fragment so
 * two DAG-distinct ids that sanitize to the same string (e.g. `auth.login` and
 * `auth_login`, or two >64-char ids differing only past char 64) still get
 * DISTINCT worktree paths + branches. Without it, the second task's gitAddWorktree
 * would force-remove the first's live worktree. */
function idHash(id: string): string {
  return createHash("sha1").update(id).digest("hex").slice(0, 8);
}

/** Collision-free, filesystem-safe worktree slug: the sanitized (capped) id plus
 * a short hash of the raw id. Both the worktree path and branch derive from this
 * ONE slug so they stay in lockstep. */
export function worktreeSlug(id: string): string {
  return `${sanitizeId(id)}-${idHash(id)}`;
}

/** The fresh branch name for a worktree task: `vibe-wt/<session-short>-<slug>`.
 * Takes an already-safe slug (from `worktreeSlug`) so it is never re-truncated —
 * truncating here would chop the disambiguating hash off the tail. */
function worktreeBranch(sessionId: string, slug: string): string {
  const short = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(-8) || "root";
  return `vibe-wt/${short}-${slug}`;
}
