import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationStore, nextTriggerAt } from "./index.ts";

function input(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "daily-review",
    workspace: "/work/repo",
    action: { goal: "review and report" },
    trigger: { kind: "interval", everyMs: 60_000 },
    ...overrides,
  };
}

test("safe defaults save without confirmation; mutating automation requires it", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-automation-save-"));
  const store = new AutomationStore(root, { now: () => 1_000 });
  const saved = await store.save(input());
  expect(saved).toMatchObject({ mode: "plan", sandboxPolicy: { mode: "read-only" }, nextRunAt: 61_000 });
  await expect(store.save(input({ mode: "execute" }))).rejects.toThrow("explicit confirmation");
  const mutating = await store.save(input({ mode: "execute", branchPolicy: "worktree" }), { confirmUnattendedMutation: true });
  expect(mutating.branchPolicy).toBe("worktree");
  expect((await stat(join(root, "automations.json"))).mode & 0o777).toBe(0o600);
});

test("durable leases skip overlap and restart recovery never duplicates a scheduled run", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-automation-lease-"));
  let now = 1_000;
  const first = new AutomationStore(root, { ownerId: "first", now: () => now, leaseMs: 70_000 });
  await first.save(input());
  now = 61_000;
  const [claim] = await first.claimDue();
  expect(claim?.run.status).toBe("running");
  expect(await first.claimDue()).toEqual([]); // same scheduled key cannot duplicate

  now = 121_000;
  const second = new AutomationStore(root, { ownerId: "second", now: () => now, leaseMs: 70_000 });
  expect(await second.claimDue()).toEqual([]); // overlap=skip
  expect((await second.history()).at(-1)?.status).toBe("skipped");

  now = 181_000;
  const recovered = await second.claimDue();
  expect(recovered).toHaveLength(1);
  const history = await second.history();
  expect(history.find((run) => run.id === claim?.run.id)?.status).toBe("interrupted");
  expect(new Set(history.map((run) => run.idempotencyKey)).size).toBe(history.length);
});

test("completion and cancellation release leases idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-automation-finish-"));
  let now = 0;
  const store = new AutomationStore(root, { ownerId: "owner", now: () => now });
  await store.save(input());
  now = 60_000;
  const [claim] = await store.claimDue();
  const cancelled = await store.cancel(claim!.run.id);
  expect(cancelled.status).toBe("cancelled");
  expect((await store.cancel(claim!.run.id)).status).toBe("cancelled");
});

test("UTC cron supports ranges, lists, and steps with strict bounds", () => {
  const after = Date.parse("2026-07-20T12:00:30Z");
  expect(nextTriggerAt({ kind: "cron", expression: "*/15 12 * * 1-5", timezone: "UTC" }, after))
    .toBe(Date.parse("2026-07-20T12:15:00Z"));
  // Conventional cron uses OR when both day-of-month and day-of-week are
  // restricted, and accepts 7 as Sunday.
  expect(nextTriggerAt({ kind: "cron", expression: "0 0 21 * 7", timezone: "UTC" }, after))
    .toBe(Date.parse("2026-07-21T00:00:00Z"));
  expect(() => nextTriggerAt({ kind: "cron", expression: "0 25 * * *", timezone: "UTC" }, after)).toThrow("range");
});
