import type { JobInfo, QueuedItem } from "./types";

export const MAX_QUEUE_ROWS = 200;
export const MAX_JOB_ROWS = 200;

export interface HeadTailRows<T> {
  head: T[];
  tail: T[];
  omitted: number;
}

/** Keep the actionable front and diagnostic tail without mounting an unbounded list. */
export function queueRowsForDisplay(
  pending: readonly QueuedItem[],
  maxRows = MAX_QUEUE_ROWS,
): HeadTailRows<QueuedItem> {
  const limit = Math.max(0, Math.floor(maxRows));
  if (pending.length <= limit) return { head: [...pending], tail: [], omitted: 0 };
  const headCount = Math.ceil(limit / 2);
  const tailCount = Math.floor(limit / 2);
  return {
    head: pending.slice(0, headCount),
    tail: tailCount > 0 ? pending.slice(-tailCount) : [],
    omitted: pending.length - limit,
  };
}

/**
 * Retain every running job when it fits, then fill the view with the newest
 * settled jobs. A pathological number of running jobs still obeys the hard DOM
 * ceiling by retaining the newest entries.
 */
export function jobsForDisplay(
  jobs: readonly JobInfo[],
  maxRows = MAX_JOB_ROWS,
): { items: JobInfo[]; omitted: number } {
  const limit = Math.max(0, Math.floor(maxRows));
  if (jobs.length <= limit) return { items: [...jobs], omitted: 0 };
  if (limit === 0) return { items: [], omitted: jobs.length };

  const running = jobs.filter((job) => job.status === "running");
  const selected = running.length >= limit
    ? running.slice(-limit)
    : [
        ...running,
        ...jobs.filter((job) => job.status !== "running").slice(-(limit - running.length)),
      ];
  const selectedRows = new Set(selected);
  return {
    items: jobs.filter((job) => selectedRows.has(job)),
    omitted: jobs.length - selected.length,
  };
}
