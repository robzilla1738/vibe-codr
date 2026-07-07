import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";
import { readTaskObjective, readTaskReport, taskReportPath } from "../build/journal.ts";

/**
 * Per-session-tree store of finished orchestrator task reports. A task handoff
 * carries only the load-bearing facts verbatim; the FULL prose report is
 * pull-only via the `read_report` tool, which reads this store. The runner fills
 * it as tasks settle. It is tree-shared — created once by the root runner and
 * inherited by every fork through SessionDeps — so a dependent task (which runs
 * as a fork) can pull a dependency's complete write-up.
 *
 * On a resumed session the in-memory map is empty, so a miss falls back to the
 * persisted report on disk (persistTaskReport wrote it under the same session
 * id + task id), keeping read_report working across --resume.
 */
export interface StoredReport {
  objective: string;
  output: string;
}

// A report can be large (a consolidated task write-up), and it lands verbatim in
// the calling agent's context — so, like every context-producing tool, cap it.
const MAX_REPORT_OUTPUT = 32_000;

export class ReportStore {
  readonly #cwd: string;
  /** The session id persistTaskReport wrote reports under (the root session). */
  readonly #sessionId: string;
  readonly #mem = new Map<string, StoredReport>();

  constructor(cwd: string, sessionId: string) {
    this.#cwd = cwd;
    this.#sessionId = sessionId;
  }

  /** Record a settled task's full report in memory. */
  set(taskId: string, report: StoredReport): void {
    this.#mem.set(taskId, report);
  }

  /** The full report for a task: memory first, then the persisted file (resume). */
  get(taskId: string): StoredReport | null {
    const hit = this.#mem.get(taskId);
    if (hit) return hit;
    const disk = readTaskReport(this.#cwd, taskReportPath(this.#cwd, this.#sessionId, taskId));
    return disk !== null
      ? { objective: readTaskObjective(this.#cwd, this.#sessionId, taskId) ?? taskId, output: disk }
      : null;
  }
}

function capReport(s: string): string {
  return s.length > MAX_REPORT_OUTPUT
    ? `${s.slice(0, MAX_REPORT_OUTPUT)}\n…(report truncated at ${MAX_REPORT_OUTPUT} chars — ask the task for a more focused summary if you need the rest)`
    : s;
}

/** Build the read-only `read_report` tool over a session tree's ReportStore. */
export function buildReadReportTool(store: ReportStore): ToolDefinition<{ task_id: string }> {
  return {
    name: "read_report",
    description:
      "Read the FULL report a finished orchestrator task produced, by its task id. " +
      "The handoffs threaded into your kickoff carry only the load-bearing facts; " +
      "call this when you need a dependency's complete write-up.",
    inputSchema: z.object({
      task_id: z.string().describe("The id of the finished task whose full report you want."),
    }),
    // A pure read of already-produced text — never prompt, safe to run in parallel.
    readOnly: true,
    concurrencySafe: true,
    execute: async ({ task_id }) => {
      const report = store.get(task_id);
      if (!report) {
        return {
          output: `No report found for task "${task_id}" (unknown id, or it has not finished yet).`,
          isError: true,
        };
      }
      return { output: capReport(report.output) };
    },
  };
}
