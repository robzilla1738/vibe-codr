import type { ActivityInfo } from "@vibe/shared";
import type { AutomationRecordV1, AutomationRunV1 } from "@vibe/automation";

/** Project automations reuse the existing cross-client Jobs activity contract,
 * so Desktop and mobile render the same scheduled/running/history records. */
export function automationActivities(specs: readonly AutomationRecordV1[], runs: readonly AutomationRunV1[], cwd: string): ActivityInfo[] {
  const relevant = specs.filter((spec) => spec.workspace === cwd);
  const ids = new Set(relevant.map((spec) => spec.id));
  const scheduled: ActivityInfo[] = relevant.filter((spec) => spec.enabled).map((spec) => ({
    id: `automation_${spec.id}`,
    kind: "monitor",
    label: `Automation · ${spec.id}`,
    status: "queued",
    summary: `Scheduled ${new Date(spec.nextRunAt).toISOString()} · ${spec.mode} · ${spec.trigger.kind}`,
  }));
  const history: ActivityInfo[] = runs.filter((run) => ids.has(run.automationId)).slice(-100).map((run) => ({
    id: `automation_run_${run.id}`,
    kind: "monitor",
    label: `Automation · ${run.automationId}`,
    status: run.status === "running" ? "running" : run.status === "completed" ? "completed"
      : run.status === "cancelled" || run.status === "skipped" ? "cancelled" : "failed",
    startedAt: run.startedAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.reason ? { summary: run.reason } : {}),
  }));
  return [...scheduled, ...history];
}
