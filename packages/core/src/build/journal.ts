import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Handoff } from "@vibe/shared";
import type { TaskResult } from "../orchestrator.ts";
import { globalStateDir } from "../state-dir.ts";

/**
 * Orchestration journal: append-only task-level events under the project's
 * GLOBAL state dir (`~/.vibe/state/<cwd-hash>/orchestration/`), so an
 * interrupted spawn_tasks run preserves its completed work — a resumed session
 * seeds the DAG with finished results instead of re-running the whole plan. Full
 * task reports are persisted alongside (reports/<taskId>.md) so read_report
 * survives resume. This is machine state (like sessions/checkpoints): keeping it
 * OUT of the project cwd is deliberate — an in-cwd `.vibe/orchestration/` used to
 * dirty a fresh scaffold target (`create-next-app .`) and re-introduce the exact
 * pollution the state relocation removed. A legacy in-cwd location is still read
 * on resume. Best-effort throughout: journaling never blocks or fails a run; a
 * torn final line (crash mid-append) is tolerated on read.
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
  return join(globalStateDir(cwd), "orchestration");
}

/** Pre-relocation in-cwd location, read-only fallback on resume. */
function legacyOrchestrationDir(cwd: string): string {
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

/** Basename of a task's persisted report file. Session-scoped so two sessions'
 * task ids can't collide. A short hash of the RAW id disambiguates ids that
 * sanitize-equal (`a.b` vs `a_b` → same slug), so the second no longer silently
 * overwrites the first's report on persist/resume. */
function reportFileName(sessionId: string, taskId: string): string {
  return `${sessionId}-${sanitize(taskId)}-${shortHash(taskId)}.md`;
}

/** The ABSOLUTE path a task's persisted report lives at (under the global state
 * dir). Exposed (not just internal to persistTaskReport) so the ReportStore can
 * locate a report on a resumed session, where its in-memory map is empty. */
export function taskReportPath(cwd: string, sessionId: string, taskId: string): string {
  return join(reportsDir(cwd), reportFileName(sessionId, taskId));
}

/** Deterministic 8-char hex hash of a string (FNV-1a). Dependency-free and
 * stable across runs, so persist and resume-lookup derive the same path. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Persist a task's full report; returns its ABSOLUTE path (for read_report
 * after resume), or undefined when the write failed. */
export function persistTaskReport(cwd: string, sessionId: string, taskId: string, report: string): string | undefined {
  try {
    mkdirSync(reportsDir(cwd), { recursive: true });
    const abs = taskReportPath(cwd, sessionId, taskId);
    writeFileSync(abs, report, "utf8");
    return abs;
  } catch {
    return undefined;
  }
}

/** Read a persisted report. `reportPath` is absolute for current runs; a legacy
 * cwd-relative `.vibe/...` path (from a pre-relocation journal) is resolved
 * against cwd so an in-progress resume across the upgrade still finds it. */
export function readTaskReport(cwd: string, reportPath: string): string | null {
  try {
    return readFileSync(isAbsolute(reportPath) ? reportPath : join(cwd, reportPath), "utf8");
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
    const global = journalPath(cwd, sessionId);
    const legacy = join(legacyOrchestrationDir(cwd), `${sessionId}.jsonl`);
    raw = readFileSync(existsSync(global) ? global : legacy, "utf8");
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
