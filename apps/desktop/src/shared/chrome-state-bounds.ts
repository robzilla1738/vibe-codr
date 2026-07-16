import { jobsForDisplay, queueRowsForDisplay } from "./live-list-bounds";
import { appendRollingText } from "./stream-cap";
import type { JobInfo, QueuedItem, Task } from "./types";

export const MAX_RETAINED_QUEUE_ITEMS = 1_000;
export const MAX_RETAINED_JOB_ITEMS = 500;
export const MAX_RETAINED_TASK_ITEMS = 1_000;
export const MAX_RETAINED_COMMAND_NAMES = 4_096;
export const QUEUE_LABEL_MAX_CHARS = 16 * 1024;
export const JOB_COMMAND_MAX_CHARS = 64 * 1024;
export const JOB_OUTPUT_TAIL_MAX_CHARS = 512 * 1024;
export const JOB_SERVER_MAX_ITEMS = 32;
export const JOB_SERVER_MAX_CHARS = 8 * 1024;
export const TASK_TITLE_MAX_CHARS = 64 * 1024;
export const COMMAND_NAME_MAX_CHARS = 4 * 1024;
const RUNTIME_ID_MAX_CHARS = 1_024;

export interface RetainedLiveState<T> {
  items: T[];
  total: number;
}

export interface RetainedTaskState extends RetainedLiveState<Task> {
  completed: number;
  unfinished: number;
}

function usableRuntimeId(id: string): boolean {
  return id.length > 0 && id.length <= RUNTIME_ID_MAX_CHARS && !id.includes("\0");
}

function boundedTail(value: string, maxChars: number): string {
  return appendRollingText("", value, maxChars);
}

/** Bound both queue cardinality and labels before they enter long-lived React state. */
export function retainQueueState(
  pending: readonly QueuedItem[],
  maxItems = MAX_RETAINED_QUEUE_ITEMS,
): RetainedLiveState<QueuedItem> {
  const projected = pending.flatMap((item) =>
    usableRuntimeId(item.id)
      ? [{ id: item.id, label: boundedTail(item.label, QUEUE_LABEL_MAX_CHARS) }]
      : [],
  );
  const rows = queueRowsForDisplay(projected, maxItems);
  return {
    items: [...rows.head, ...rows.tail],
    total: pending.length,
  };
}

/** Preserve running jobs and newest settled jobs while bounding every retained
 * string/list field. The authoritative engine may keep a longer history; the
 * renderer reports the original total separately. */
export function retainJobState(
  jobs: readonly JobInfo[],
  maxItems = MAX_RETAINED_JOB_ITEMS,
): RetainedLiveState<JobInfo> {
  const projected = jobs.flatMap((job) => {
    if (!usableRuntimeId(job.id)) return [];
    const servers = job.servers
      .filter((server) => server.length <= JOB_SERVER_MAX_CHARS && !server.includes("\0"))
      .slice(-JOB_SERVER_MAX_ITEMS);
    return [{
      ...job,
      command: boundedTail(job.command, JOB_COMMAND_MAX_CHARS),
      servers,
      outputTail: boundedTail(job.outputTail, JOB_OUTPUT_TAIL_MAX_CHARS),
    }];
  });
  const rows = jobsForDisplay(projected, maxItems);
  return { items: rows.items, total: jobs.length };
}

/** Keep actionable work first, then the newest completed context. Aggregate
 * counts are computed from the authoritative snapshot before projection. */
export function retainTaskState(
  tasks: readonly Task[],
  maxItems = MAX_RETAINED_TASK_ITEMS,
): RetainedTaskState {
  const limit = Math.max(0, Math.floor(maxItems));
  const completed = tasks.filter((task) => task.status === "completed").length;
  const projected = tasks.flatMap((task) =>
    usableRuntimeId(task.id)
      ? [{ ...task, title: boundedTail(task.title, TASK_TITLE_MAX_CHARS) }]
      : [],
  );
  const actionable = projected.filter((task) => task.status !== "completed");
  const selected = actionable.length >= limit
    ? actionable.slice(0, limit)
    : [
        ...actionable,
        ...projected
          .filter((task) => task.status === "completed")
          .slice(-(limit - actionable.length)),
      ];
  const selectedRows = new Set(selected);
  return {
    items: projected.filter((task) => selectedRows.has(task)),
    total: tasks.length,
    completed,
    unfinished: tasks.length - completed,
  };
}

/** Command names drive recognition hints, not execution. Keep a large, stable,
 * first-seen set without allowing a pathological snapshot to pin the renderer. */
export function retainCommandNames(
  commandNames: readonly string[],
  maxItems = MAX_RETAINED_COMMAND_NAMES,
): string[] {
  const limit = Math.max(0, Math.floor(maxItems));
  const seen = new Set<string>();
  const retained: string[] = [];
  for (const name of commandNames) {
    if (!name || name.length > COMMAND_NAME_MAX_CHARS || name.includes("\0") || seen.has(name)) {
      continue;
    }
    seen.add(name);
    retained.push(name);
    if (retained.length >= limit) break;
  }
  return retained;
}
