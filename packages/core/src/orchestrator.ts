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
}

/** Runs one task (the caller forks + runs a subagent). Receives the results of
 * the task's dependencies so it can thread their outputs into the kickoff. */
export type RunTask = (spec: TaskSpec, depResults: TaskResult[]) => Promise<TaskResult>;

export interface DagEvents {
  /** A task changed state (running, or a terminal outcome). */
  onStatus?: (spec: TaskSpec, status: "running" | TaskOutcome) => void;
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
        events.onStatus?.(s, "skipped");
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
          events.onStatus?.(byId.get(s.id)!, result.outcome);
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
