import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Handoff } from "@vibe/shared";
import type { TaskResult } from "../orchestrator.ts";

/**
 * Orchestration journal: append-only task-level events under
 * `.vibe/orchestration/`, so an interrupted spawn_tasks run preserves its
 * completed work — a resumed session seeds the DAG with finished results
 * instead of re-running the whole plan. Full task reports are persisted
 * alongside (reports/<taskId>.md) so read_report survives resume. Best-effort
 * throughout: journaling never blocks or fails a run; a torn final line (crash
 * mid-append) is tolerated on read.
 */

export interface TaskStartedEvent {
  type: "task-started";
  at: number;
  id: string;
  objective: string;
  deps: string[];
  tier?: string;
  worktree?: boolean;
}

export interface TaskFinishedEvent {
  type: "task-finished";
  at: number;
  id: string;
  objective: string;
  outcome: TaskResult["outcome"];
  attempts: number;
  handoff?: Handoff;
  /** Relative path of the persisted full report, when one was written. */
  reportPath?: string;
}

export type OrchestrationEvent = TaskStartedEvent | TaskFinishedEvent;

function orchestrationDir(cwd: string): string {
  return join(cwd, ".vibe", "orchestration");
}

function journalPath(cwd: string, sessionId: string): string {
  return join(orchestrationDir(cwd), `${sessionId}.jsonl`);
}

function reportsDir(cwd: string): string {
  return join(orchestrationDir(cwd), "reports");
}

export function appendOrchestrationEvent(cwd: string, sessionId: string, event: OrchestrationEvent): void {
  try {
    mkdirSync(orchestrationDir(cwd), { recursive: true });
    appendFileSync(journalPath(cwd, sessionId), `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    /* journaling is best-effort — never fail the run over it */
  }
}

/** The cwd-relative path a task's persisted report lives at. Session-scoped so
 * two sessions' task ids can't collide. Exposed (not just internal to
 * persistTaskReport) so the ReportStore can locate a report on a resumed
 * session, where its in-memory map is empty. */
export function taskReportPath(sessionId: string, taskId: string): string {
  return join(".vibe", "orchestration", "reports", `${sessionId}-${sanitize(taskId)}.md`);
}

/** Persist a task's full report; returns its cwd-relative path (for read_report
 * after resume), or undefined when the write failed. */
export function persistTaskReport(cwd: string, sessionId: string, taskId: string, report: string): string | undefined {
  try {
    mkdirSync(reportsDir(cwd), { recursive: true });
    const rel = taskReportPath(sessionId, taskId);
    writeFileSync(join(cwd, rel), report, "utf8");
    return rel;
  } catch {
    return undefined;
  }
}

export function readTaskReport(cwd: string, reportPath: string): string | null {
  try {
    return readFileSync(join(cwd, reportPath), "utf8");
  } catch {
    return null;
  }
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64);
}

/** Replay a session's journal into the completed results usable as a runDag
 * seed. In-flight (started but never finished) tasks are simply absent — they
 * re-run. Malformed lines are skipped, never thrown on. */
export function loadCompletedTasks(cwd: string, sessionId: string): TaskResult[] {
  let raw: string;
  try {
    raw = readFileSync(journalPath(cwd, sessionId), "utf8");
  } catch {
    return [];
  }
  const done = new Map<string, TaskResult>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: OrchestrationEvent;
    try {
      ev = JSON.parse(line) as OrchestrationEvent;
    } catch {
      continue;
    }
    if (ev.type !== "task-finished" || ev.outcome !== "completed") continue;
    const report = ev.reportPath ? readTaskReport(cwd, ev.reportPath) : null;
    done.set(ev.id, {
      id: ev.id,
      objective: ev.objective,
      outcome: ev.outcome,
      output: report ?? "(completed in a prior run; full report unavailable)",
      attempts: ev.attempts,
      ...(ev.handoff ? { handoff: ev.handoff } : {}),
    });
  }
  return [...done.values()];
}
