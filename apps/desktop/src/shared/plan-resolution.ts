import type { GoalRunInfo } from "./types";

/** Mirror the engine's semantic plan-accept guard before optimistic UI changes. */
export function planResolutionBlockedReason(
  decision: "accept" | "edit" | "keep-planning",
  goalRun: GoalRunInfo | null,
): string | null {
  if (decision === "accept" && goalRun?.active) {
    return "A goal run owns the task list. Clear the goal run before accepting this plan.";
  }
  return null;
}
