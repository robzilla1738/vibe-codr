import { expect, test } from "bun:test";
import { AutomationSpecV1Schema, automationCanMutate } from "./automation.ts";

test("AutomationSpecV1 defaults to read-only plan, skip policies, and bounded spend", () => {
  const spec = AutomationSpecV1Schema.parse({
    schemaVersion: 1,
    id: "nightly-plan",
    workspace: "/work/repo",
    action: { goal: "review the repository" },
    trigger: { kind: "interval", everyMs: 60_000 },
  });
  expect(spec).toMatchObject({
    mode: "plan",
    tier: "default",
    timeoutMs: 1_800_000,
    spendCeilingUSD: 5,
    sandboxPolicy: { mode: "read-only", network: "off" },
    branchPolicy: "none",
    overlapPolicy: "skip",
    missedRunPolicy: "skip",
  });
  expect(automationCanMutate(spec)).toBe(false);
});

test("AutomationSpecV1 rejects ambiguous actions and unknown execution fields", () => {
  const base = {
    schemaVersion: 1, id: "x", workspace: "/work/repo",
    trigger: { kind: "interval", everyMs: 60_000 },
  } as const;
  expect(() => AutomationSpecV1Schema.parse({ ...base, action: { prompt: "x", goal: "y" } })).toThrow();
  expect(() => AutomationSpecV1Schema.parse({ ...base, action: { prompt: "x" }, remoteShell: true })).toThrow();
});
