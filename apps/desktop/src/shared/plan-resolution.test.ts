import { describe, expect, it } from "vitest";
import { planResolutionBlockedReason } from "./plan-resolution";
import type { GoalRunInfo } from "./types";

const activeRun: GoalRunInfo = {
  active: true,
  phase: "execute",
  round: 1,
  max: 5,
  pausedReason: null,
  met: false,
};

describe("plan resolution guard", () => {
  it("blocks accept while a goal run owns tasks without blocking revision", () => {
    expect(planResolutionBlockedReason("accept", activeRun)).toContain("owns the task list");
    expect(planResolutionBlockedReason("edit", activeRun)).toBeNull();
    expect(planResolutionBlockedReason("keep-planning", activeRun)).toBeNull();
    expect(planResolutionBlockedReason("accept", { ...activeRun, active: false })).toBeNull();
  });
});
