import { expect, test } from "bun:test";
import { automationActivities } from "./automation-activities.ts";

test("automations project into the shared Jobs activity surface", () => {
  const specs = [{ schemaVersion: 1 as const, id: "nightly", workspace: "/repo", action: { prompt: "inspect" }, tier: "default" as const, mode: "plan" as const, trigger: { kind: "interval" as const, everyMs: 60_000 }, timeoutMs: 1_000, spendCeilingUSD: 1, permissionProfile: "default", sandboxPolicy: { mode: "read-only" as const, network: "off" as const }, branchPolicy: "none" as const, enabled: true, overlapPolicy: "skip" as const, missedRunPolicy: "skip" as const, createdAt: 1, updatedAt: 1, nextRunAt: 60_001 }];
  const runs = [{ id: "run-1", automationId: "nightly", idempotencyKey: "x", scheduledAt: 1, startedAt: 2, finishedAt: 3, status: "failed" as const, reason: "spend ceiling" }];
  expect(automationActivities(specs, runs, "/repo")).toMatchObject([{ status: "queued" }, { status: "failed", summary: "spend ceiling" }]);
  expect(automationActivities(specs, runs, "/other")).toEqual([]);
});
