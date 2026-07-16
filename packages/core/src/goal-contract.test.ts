import { describe, expect, test } from "bun:test";
import { freezeGoalContract, formatGoalContract, gapFingerprint } from "./goal-contract.ts";

describe("goal contract", () => {
  test("freezes sectioned plan outcomes and keeps task fallback", () => {
    const contract = freezeGoalContract(
      "Ship durable planning",
      [
        "## Acceptance criteria",
        "- Pending approval survives restart",
        "## Verification plan",
        "- Resume the session and accept the plan",
        "## Non-goals",
        "- Restyle the app",
        "## Implementation plan",
        "- [ ] Persist the plan state",
        "## Risks",
        "- Stale approval races",
      ].join("\n"),
      [{ id: "t1", title: "Wire the desktop snapshot", status: "pending" }],
    );

    expect(contract.goal).toBe("Ship durable planning");
    expect(contract.acceptanceCriteria).toEqual(["Pending approval survives restart"]);
    expect(contract.verificationPlan).toEqual(["Resume the session and accept the plan"]);
    expect(contract.nonGoals).toEqual(["Restyle the app"]);
    expect(contract.implementationPlan).toEqual(["Persist the plan state"]);
    expect(formatGoalContract(contract)).toContain("FROZEN GOAL CONTRACT");
  });

  test("normalizes repeated gap wording into a stable fingerprint", () => {
    expect(gapFingerprint(["t2 pending: Fix `src/a.ts` at line 42"]))
      .toBe(gapFingerprint(["T2 pending - Fix `src/b.ts` at line 99"]));
  });
});
