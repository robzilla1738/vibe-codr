/**
 * A deterministic task-DAG scheduler (the agentswarm Executor pattern). Instead
 * of the model emitting N parallel `spawn_subagent` calls and hoping they
 * interleave well, it submits a whole plan of tasks — each with declared
 * dependencies — and the ENGINE runs them: every dependency-satisfied task is
 * dispatched (concurrency is bounded downstream by the per-session child gate +
 * the tree-global provider limiter), dependents unlock as their inputs complete,
 * and a task whose dependency failed is skipped rather than run on bad inputs.
 *
 * The scheduler is pure and headless — it knows nothing about sessions or the
 * UI; the caller supplies `runTask` (which forks + runs a subagent) and an
 * optional status callback (which the engine turns into UIEvents).
 */

export interface TaskSpec {
  /** Stable id, referenced by other tasks' `deps`. */
  id: string;
  /** Identity of the plan this task was submitted in (planIdentity of the whole
   * spec set, stamped by spawn_tasks). Journal events carry it so a resumed run
   * seeds ONLY from its own plan's prior completions — a later plan in the same
   * session reusing an id (even with an identical objective) never inherits a
   * stale result. Not part of the model-facing schema. */
  plan?: string;
  /** The self-contained objective handed to the subagent. */
  objective: string;
  /** Ids of tasks that must complete before this one starts. */
  deps: string[];
  /** Files this task owns (surfaced to the subagent; enforced by the file lock). */
  files?: string[];
  /** Run a verify→retry pass after the task (review agent / checks). */
  verify?: boolean;
  /** Named agent to specialize the subagent. */
  agent?: string;
  /** Model tier: "cheap" for scouts/mechanical work, "strong" for
   * leads/reviewers/verifiers. Resolved to a CONFIG model string (never a
   * model-invented provider); unset falls back to the subagent.model chain. */
  tier?: "cheap" | "strong";
  /** Run the repo's real detected checks (the green-gate) after this task; a red
   * gate fails the attempt without spending an LLM review call. */
  check?: boolean;
  /** Run this task in an isolated git worktree — for parallel writers whose file
   * sets can't be declared disjoint. Its changes squash-merge back on success
   * (and the gate/review run on the MERGED main tree); a conflicting merge fails
   * the task. Ignored when worktrees are unavailable (falls back to shared tree). */
  worktree?: boolean;
  /** Run as a best-of-N ensemble in isolated worktrees (when build.ensemble.n>0):
   * N attempts of the same objective, each with a distinct strategy, judged by an
   * in-worktree gate — only the winner merges. Expensive; reserve for genuinely
   * hard tasks. */
  hard?: boolean;
  /** Optional JSON Schema. When set (shared-tree tasks), the subagent's FINAL
   * message must be exactly one JSON object matching it — validated, retried on
   * mismatch (subagent.structuredMaxAttempts); the validated JSON becomes the
   * task report. Machine-consumable task results. */
  outputSchema?: Record<string, unknown>;
}

export type TaskOutcome = "completed" | "failed" | "skipped";

export interface TaskResult {
  id: string;
  objective: string;
  outcome: TaskOutcome;
  /** The subagent's final report (or the failure/skip reason). */
  output: string;
  /** How many attempts ran (≥ 1 for a task that started; 0 if skipped). */
  attempts: number;
  /** Wall-clock the task took, ms — set by the runner on a settled task (absent
   * on a skipped/seeded-without-timing task). Surfaced on the terminal UIEvent. */
  durationMs?: number;
  /** Structured handoff parsed from the report's ```handoff fence, when the
   * child emitted one — dependents receive these fields verbatim. */
  handoff?: import("@vibe/shared").Handoff;
}

/** Runs one task (the caller forks + runs a subagent). Receives the results of
 * the task's dependencies so it can thread their outputs into the kickoff. */
export type RunTask = (spec: TaskSpec, depResults: TaskResult[]) => Promise<TaskResult>;

export interface DagEvents {
  /** A task changed state (running, or a terminal outcome). On a terminal status
   * the settled `result` is passed too, so a caller can surface attempts/timing. */
  onStatus?: (spec: TaskSpec, status: "running" | TaskOutcome, result?: TaskResult) => void;
  /** Completed results from a PRIOR run (e.g. a --resume'd session's journal):
   * seeded results pre-populate the map, count as settled for dependency
   * resolution, and are surfaced via onStatus — so only unfinished tasks re-run.
   * Only ids present in the current spec set are honored (a stale journal entry
   * for a removed task is ignored). */
  seed?: TaskResult[];
}

/**
 * Validate a task plan: unique ids, every dep references a real task, and no
 * dependency cycle. Returns an error message, or null when the plan is runnable.
 */
export function validateDag(specs: TaskSpec[]): string | null {
  if (!specs.length) return "no tasks provided";
  const ids = new Set<string>();
  for (const s of specs) {
    if (!s.id) return "every task needs an id";
    if (ids.has(s.id)) return `duplicate task id "${s.id}"`;
    ids.add(s.id);
  }
  for (const s of specs) {
    for (const d of s.deps) {
      if (!ids.has(d)) return `task "${s.id}" depends on unknown task "${d}"`;
      if (d === s.id) return `task "${s.id}" depends on itself`;
    }
  }
  // Cycle detection via DFS coloring.
  const byId = new Map(specs.map((s) => [s.id, s]));
  const color = new Map<string, 0 | 1 | 2>(); // 0=unseen 1=in-stack 2=done
  const visit = (id: string): string | null => {
    color.set(id, 1);
    for (const d of byId.get(id)!.deps) {
      const c = color.get(d) ?? 0;
      if (c === 1) return `dependency cycle through "${d}"`;
      if (c === 0) {
        const err = visit(d);
        if (err) return err;
      }
    }
    color.set(id, 2);
    return null;
  };
  for (const s of specs) {
    if ((color.get(s.id) ?? 0) === 0) {
      const err = visit(s.id);
      if (err) return err;
    }
  }
  return null;
}

/**
 * Run a validated task DAG to completion. Every task whose dependencies have all
 * completed is dispatched immediately (so independent tasks run in parallel);
 * the loop wakes whenever any task settles and re-evaluates what's now ready.
 * A task with a failed/skipped dependency is marked skipped without running.
 * Results are returned in the original spec order.
 */
export async function runDag(
  specs: TaskSpec[],
  runTask: RunTask,
  events: DagEvents = {},
): Promise<TaskResult[]> {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const results = new Map<string, TaskResult>();
  const inflight = new Map<string, Promise<void>>();
  const started = new Set<string>();

  // Seed prior-run completions so a resumed session re-runs only what's left.
  // Only ids that still exist in this plan are honored, so a stale journal entry
  // never resurrects a removed task; seeded tasks count as settled + started.
  if (events.seed?.length) {
    // Candidates: prior results whose id still exists AND whose OBJECTIVE is
    // unchanged. Plan-drift guard: a reused id (generic `impl`/`test`/`fix`) whose
    // objective changed is a DIFFERENT task — seeding it would skip the new work
    // and report the old objective, so it must re-run.
    const seedById = new Map(
      events.seed
        .filter((r) => byId.get(r.id) && byId.get(r.id)!.objective === r.objective)
        .map((r) => [r.id, r] as const),
    );
    // Seed to a FIXPOINT, only seeding a task once every dep is ALSO seeded. If a
    // dep drifted (or is absent from the seed), it re-runs — and so must every
    // transitive dependent, otherwise a dependent's stale result would be retained
    // against a dep that produced a fresh (possibly different) output.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, r] of seedById) {
        if (results.has(id)) continue;
        const spec = byId.get(id)!;
        if (!spec.deps.every((d) => results.has(d))) continue; // a dep isn't seeded → don't seed this
        results.set(id, r);
        started.add(id);
        events.onStatus?.(spec, r.outcome, r);
        changed = true;
      }
    }
  }

  const depResultsOf = (s: TaskSpec): TaskResult[] =>
    s.deps.map((d) => results.get(d)).filter((r): r is TaskResult => r !== undefined);
  const depsAllDone = (s: TaskSpec): boolean =>
    s.deps.every((d) => results.has(d));
  const anyDepNotCompleted = (s: TaskSpec): boolean =>
    s.deps.some((d) => results.get(d)?.outcome !== "completed");

  while (results.size < specs.length) {
    // Dispatch every ready, not-yet-started task.
    for (const s of specs) {
      if (started.has(s.id) || !depsAllDone(s)) continue;
      started.add(s.id);
      if (anyDepNotCompleted(s)) {
        const result: TaskResult = {
          id: s.id,
          objective: s.objective,
          outcome: "skipped",
          output: "Skipped: a dependency did not complete.",
          attempts: 0,
        };
        results.set(s.id, result);
        events.onStatus?.(s, "skipped", result);
        continue;
      }
      events.onStatus?.(s, "running");
      const promise = runTask(s, depResultsOf(s))
        .catch(
          (err): TaskResult => ({
            id: s.id,
            objective: s.objective,
            outcome: "failed",
            output: `Task threw: ${(err as Error)?.message ?? String(err)}`,
            attempts: 1,
          }),
        )
        .then((result) => {
          results.set(s.id, result);
          inflight.delete(s.id);
          events.onStatus?.(byId.get(s.id)!, result.outcome, result);
        });
      inflight.set(s.id, promise);
    }

    if (inflight.size === 0) {
      // Nothing running and not everything done → the rest are unreachable
      // (shouldn't happen after validateDag, but fail closed rather than hang).
      for (const s of specs) {
        if (!results.has(s.id)) {
          results.set(s.id, {
            id: s.id,
            objective: s.objective,
            outcome: "skipped",
            output: "Skipped: unreachable (dependency never completed).",
            attempts: 0,
          });
        }
      }
      break;
    }
    // Wake when any in-flight task settles, then re-evaluate the ready set.
    await Promise.race(inflight.values());
  }
  await Promise.all(inflight.values());
  return specs.map((s) => results.get(s.id)!);
}

/** Render task results as a consolidated report for the planner. */
export function formatTaskResults(results: TaskResult[]): string {
  const done = results.filter((r) => r.outcome === "completed").length;
  const lines = results.map((r) => {
    const mark = r.outcome === "completed" ? "✓" : r.outcome === "failed" ? "✗" : "–";
    return `${mark} [${r.id}] ${r.objective}\n${r.output.trim()}`;
  });
  return `Orchestrated ${results.length} task(s) — ${done} completed, ${results.length - done} not:\n\n${lines.join("\n\n")}`;
}
