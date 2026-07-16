import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { Handoff } from "@vibe/shared";
import type { TaskResult, TaskSpec } from "../orchestrator.ts";
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
 * events are persisted as per-event temp+rename files; legacy/torn JSONL is
 * still tolerated on read.
 */

export interface TaskStartedEvent {
  type: "task-started";
  at: number;
  id: string;
  objective: string;
  deps: string[];
  tier?: string;
  worktree?: boolean;
  /** Identity of the plan this task ran under (see planIdentity). */
  plan?: string;
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
  /** Identity of the plan this task ran under (see planIdentity). */
  plan?: string;
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

function eventDir(cwd: string, sessionId: string): string {
  return join(orchestrationDir(cwd), "events", `${sanitize(sessionId)}-${shortHash(sessionId)}`);
}

function reportsDir(cwd: string): string {
  return join(orchestrationDir(cwd), "reports");
}

let eventWriteSeq = 0;

export function appendOrchestrationEvent(
  cwd: string,
  sessionId: string,
  event: OrchestrationEvent,
): void {
  try {
    const dir = eventDir(cwd, sessionId);
    mkdirSync(dir, { recursive: true });
    const seq = eventWriteSeq++;
    const base = `${String(Date.now()).padStart(13, "0")}-${process.pid}-${seq}-${Math.random().toString(36).slice(2)}`;
    const tmp = join(dir, `${base}.tmp`);
    const final = join(dir, `${base}.json`);
    writeFileSync(tmp, `${JSON.stringify(event)}\n`, "utf8");
    renameSync(tmp, final);
  } catch {
    /* journaling is best-effort — never fail the run over it */
  }
}

/** Basename of a task's persisted report file. Session-scoped so two sessions'
 * task ids can't collide. A short hash of the RAW id disambiguates ids that
 * sanitize-equal (`a.b` vs `a_b` → same slug), so the second no longer silently
 * overwrites the first's report on persist/resume. */
export function sessionReportFilePrefix(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return `${sanitize(sessionId)}-${digest}--`;
}

function legacyReportFileName(sessionId: string, taskId: string): string {
  return `${sessionId}-${sanitize(taskId)}-${shortHash(taskId)}.md`;
}

function reportFileName(sessionId: string, taskId: string): string {
  return `${sessionReportFilePrefix(sessionId)}${sanitize(taskId)}-${shortHash(taskId)}.md`;
}

export function isTaskReportFileName(sessionId: string, taskId: string, name: string): boolean {
  return (
    name === reportFileName(sessionId, taskId) || name === legacyReportFileName(sessionId, taskId)
  );
}

/** The ABSOLUTE path a task's persisted report lives at (under the global state
 * dir). Exposed (not just internal to persistTaskReport) so the ReportStore can
 * locate a report on a resumed session, where its in-memory map is empty. */
export function taskReportPath(cwd: string, sessionId: string, taskId: string): string {
  const modern = join(reportsDir(cwd), reportFileName(sessionId, taskId));
  if (existsSync(modern)) return modern;
  const legacy = join(reportsDir(cwd), legacyReportFileName(sessionId, taskId));
  return existsSync(legacy) ? legacy : modern;
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
export function persistTaskReport(
  cwd: string,
  sessionId: string,
  taskId: string,
  report: string,
): string | undefined {
  try {
    mkdirSync(reportsDir(cwd), { recursive: true });
    const abs = join(reportsDir(cwd), reportFileName(sessionId, taskId));
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

/** Look up the last journaled objective for a task in this session. Used by
 * read_report's disk fallback on resume, where the report body is deterministic
 * by id but the human objective lives in the journal event. */
export function readTaskObjective(cwd: string, sessionId: string, taskId: string): string | null {
  let objective: string | null = null;
  for (const ev of [...readLegacyJsonl(cwd, sessionId), ...readEventFiles(cwd, sessionId)]) {
    if (ev.id === taskId) objective = ev.objective;
  }
  return objective;
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64);
}

/** Stable identity of a submitted task plan: a short hash over every task's
 * behavior-bearing fields, in submission order. The journal is per-SESSION, so
 * within one session two different spawn_tasks plans append to the same file —
 * matching a seed by id+objective alone let a later plan that reuses an id
 * (with the same objective text) inherit the earlier plan's stale result. Every
 * journal event carries this stamp, and seeding honors only events from the
 * SAME plan (a resume re-submits the identical plan → identical hash).
 * files/verify/check/tier/worktree/hard/agent/outputSchema are hashed too: a
 * re-plan that flips verification, isolation, agent routing, structured output,
 * or ownership must re-run, not inherit a completion produced under weaker
 * rules. */
export function planIdentity(
  specs: ReadonlyArray<
    Pick<
      TaskSpec,
      | "id"
      | "objective"
      | "deps"
      | "files"
      | "verify"
      | "check"
      | "tier"
      | "worktree"
      | "hard"
      | "agent"
      | "outputSchema"
    >
  >,
): string {
  return shortHash(
    JSON.stringify(
      specs.map((s) => [
        s.id,
        s.objective,
        s.deps,
        s.files ?? null,
        s.verify ?? null,
        s.check ?? null,
        s.tier ?? null,
        s.worktree ?? null,
        s.hard ?? null,
        s.agent ?? null,
        stableJsonValue(s.outputSchema ?? null),
      ]),
    ),
  );
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableJsonValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

function readEventFiles(cwd: string, sessionId: string): OrchestrationEvent[] {
  const dir = eventDir(cwd, sessionId);
  try {
    const events: OrchestrationEvent[] = [];
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      try {
        events.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as OrchestrationEvent);
      } catch {
        // A bad event file is skipped, matching legacy malformed-line handling.
      }
    }
    return events;
  } catch {
    return [];
  }
}

function readLegacyJsonl(cwd: string, sessionId: string): OrchestrationEvent[] {
  let raw: string;
  try {
    const global = journalPath(cwd, sessionId);
    const legacy = join(legacyOrchestrationDir(cwd), `${sessionId}.jsonl`);
    raw = readFileSync(existsSync(global) ? global : legacy, "utf8");
  } catch {
    return [];
  }
  const events: OrchestrationEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as OrchestrationEvent);
    } catch {
      // Malformed/torn legacy JSONL lines are ignored.
    }
  }
  return events;
}

/** Replay a session's journal into the completed results usable as a runDag
 * seed. In-flight (started but never finished) tasks are simply absent — they
 * re-run. Malformed lines are skipped, never thrown on. When `plan` is given,
 * only events stamped with that plan identity seed — unstamped (pre-upgrade)
 * events re-run, the safe direction for a one-time migration cost. */
export function loadCompletedTasks(cwd: string, sessionId: string, plan?: string): TaskResult[] {
  const done = new Map<string, TaskResult>();
  for (const ev of [...readLegacyJsonl(cwd, sessionId), ...readEventFiles(cwd, sessionId)]) {
    if (ev.type !== "task-finished" || ev.outcome !== "completed") continue;
    if (plan !== undefined && ev.plan !== plan) continue; // another plan's task — never a seed
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
