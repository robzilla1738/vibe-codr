import { test, expect } from "bun:test";
import {
  mkdtempSync,
  appendFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOrchestrationEvent,
  persistTaskReport,
  planIdentity,
  readTaskReport,
  loadCompletedTasks,
} from "./journal.ts";
import { globalStateDir } from "../state-dir.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "vibe-journal-"));

test("completed tasks replay with their persisted reports; in-flight tasks re-run", async () => {
  const cwd = tmp();
  const ses = "ses_1";
  appendOrchestrationEvent(cwd, ses, {
    type: "task-started",
    at: 1,
    id: "t1",
    objective: "build a",
    deps: [],
  });
  const reportPath = persistTaskReport(cwd, ses, "t1", "full report of t1");
  expect(reportPath).toBeDefined();
  appendOrchestrationEvent(cwd, ses, {
    type: "task-finished",
    at: 2,
    id: "t1",
    objective: "build a",
    outcome: "completed",
    attempts: 1,
    handoff: { keyFacts: ["a done"], filesTouched: ["a.ts"], openQuestions: [] },
    ...(reportPath ? { reportPath } : {}),
  });
  // t2 started but never finished — must NOT be seeded.
  appendOrchestrationEvent(cwd, ses, {
    type: "task-started",
    at: 3,
    id: "t2",
    objective: "build b",
    deps: ["t1"],
  });

  const seeded = loadCompletedTasks(cwd, ses);
  expect(seeded).toHaveLength(1);
  expect(seeded[0]?.id).toBe("t1");
  expect(seeded[0]?.output).toBe("full report of t1");
  expect(seeded[0]?.handoff?.keyFacts).toEqual(["a done"]);
});

test("failed tasks are not seeded; torn/malformed lines tolerated", () => {
  const cwd = tmp();
  const ses = "ses_2";
  appendOrchestrationEvent(cwd, ses, {
    type: "task-finished",
    at: 1,
    id: "bad",
    objective: "x",
    outcome: "failed",
    attempts: 2,
  });
  // Append a torn line to the ACTUAL (global) journal the writer used.
  appendFileSync(join(globalStateDir(cwd), "orchestration", `${ses}.jsonl`), '{"type":"task-fin');
  expect(loadCompletedTasks(cwd, ses)).toEqual([]);
});

test("completed tasks replay from atomic event files without a jsonl journal", () => {
  const cwd = tmp();
  const ses = "ses_atomic";
  appendOrchestrationEvent(cwd, ses, {
    type: "task-finished",
    at: 1,
    id: "done",
    objective: "x",
    outcome: "completed",
    attempts: 1,
  });
  const orchDir = join(globalStateDir(cwd), "orchestration");
  expect(existsSync(join(orchDir, `${ses}.jsonl`))).toBe(false);
  const eventRoot = join(orchDir, "events");
  const [sessionDir] = readdirSync(eventRoot);
  expect(sessionDir).toContain("ses_atomic");
  writeFileSync(join(eventRoot, sessionDir!, "ignored.tmp"), '{"type":"task-finished"');

  const seeded = loadCompletedTasks(cwd, ses);
  expect(seeded.map((r) => r.id)).toEqual(["done"]);
  unlinkSync(join(eventRoot, sessionDir!, "ignored.tmp"));
});

test("orchestration state is written OUT of the project cwd (global state dir)", () => {
  // Machine state must not dirty a fresh scaffold target — the same relocation
  // that moved sessions/checkpoints. The report path is absolute under the
  // global state dir, never inside the project's .vibe/.
  const cwd = tmp();
  const ses = "ses_reloc";
  appendOrchestrationEvent(cwd, ses, {
    type: "task-started",
    at: 1,
    id: "t",
    objective: "o",
    deps: [],
  });
  const reportPath = persistTaskReport(cwd, ses, "t", "report body")!;
  expect(reportPath.startsWith(globalStateDir(cwd))).toBe(true);
  expect(reportPath).not.toContain(join(cwd, ".vibe"));
  expect(existsSync(join(cwd, ".vibe", "orchestration"))).toBe(false);
  // The absolute report path round-trips through read.
  expect(readTaskReport(cwd, reportPath)).toBe("report body");
});

test("a pre-relocation in-cwd journal + report still resume (legacy read fallback)", () => {
  const cwd = tmp();
  const ses = "ses_legacy";
  const legacyDir = join(cwd, ".vibe", "orchestration");
  mkdirSync(join(legacyDir, "reports"), { recursive: true });
  const relReport = join(".vibe", "orchestration", "reports", "legacy.md");
  writeFileSync(join(cwd, relReport), "legacy report");
  writeFileSync(
    join(legacyDir, `${ses}.jsonl`),
    `${JSON.stringify({ type: "task-finished", at: 1, id: "t", objective: "o", outcome: "completed", attempts: 1, reportPath: relReport })}\n`,
  );
  const [seeded] = loadCompletedTasks(cwd, ses);
  expect(seeded?.id).toBe("t");
  expect(seeded?.output).toBe("legacy report"); // relative legacy path resolved against cwd
});

test("missing journal loads empty; missing report degrades to a placeholder", () => {
  const cwd = tmp();
  expect(loadCompletedTasks(cwd, "nope")).toEqual([]);
  const ses = "ses_3";
  appendOrchestrationEvent(cwd, ses, {
    type: "task-finished",
    at: 1,
    id: "t",
    objective: "x",
    outcome: "completed",
    attempts: 1,
    reportPath: ".vibe/orchestration/reports/deleted.md",
  });
  const [seeded] = loadCompletedTasks(cwd, ses);
  expect(seeded?.output).toContain("report unavailable");
  expect(readTaskReport(cwd, ".vibe/orchestration/reports/deleted.md")).toBeNull();
});

test("task ids are sanitized in report filenames", () => {
  const cwd = tmp();
  const rel = persistTaskReport(cwd, "s", "weird/../id with spaces", "content");
  expect(rel).toBeDefined();
  expect(rel).not.toContain("..");
  expect(readTaskReport(cwd, rel!)).toBe("content");
});

test("a task seeds only from its OWN plan's prior run (plan identity, same session)", () => {
  // The journal is per-session, so two spawn_tasks plans in the SAME session
  // share one file. A later plan reusing a task id with an IDENTICAL objective
  // used to inherit the earlier plan's stale result (the id+objective drift
  // guard can't tell them apart) — the plan-identity stamp does.
  const cwd = tmp();
  const ses = "ses_plan";
  const planA = planIdentity([{ id: "impl", objective: "Implement X", deps: [] }]);
  appendOrchestrationEvent(cwd, ses, {
    type: "task-finished",
    at: 1,
    id: "impl",
    objective: "Implement X",
    outcome: "completed",
    attempts: 1,
    plan: planA,
  });
  // A resume that re-submits the SAME plan seeds its completed task.
  expect(loadCompletedTasks(cwd, ses, planA).map((r) => r.id)).toEqual(["impl"]);
  // A DIFFERENT plan reusing the id + the exact objective text must NOT seed.
  const planB = planIdentity([
    { id: "impl", objective: "Implement X", deps: [] },
    { id: "test", objective: "Test X", deps: ["impl"] },
  ]);
  expect(planB).not.toBe(planA);
  expect(loadCompletedTasks(cwd, ses, planB)).toEqual([]);
  // An unfiltered load (no plan given) keeps the pre-stamp behavior.
  expect(loadCompletedTasks(cwd, ses)).toHaveLength(1);
});

test("unstamped (pre-upgrade) journal events never seed a plan-filtered load", () => {
  // The safe migration direction: a legacy event without a plan stamp re-runs
  // (one-time cost) rather than risking a cross-plan stale seed.
  const cwd = tmp();
  const ses = "ses_plan_legacy";
  appendOrchestrationEvent(cwd, ses, {
    type: "task-finished",
    at: 1,
    id: "impl",
    objective: "Implement X",
    outcome: "completed",
    attempts: 1,
  });
  const plan = planIdentity([{ id: "impl", objective: "Implement X", deps: [] }]);
  expect(loadCompletedTasks(cwd, ses, plan)).toEqual([]);
  expect(loadCompletedTasks(cwd, ses)).toHaveLength(1); // unfiltered still reads it
});

test("planIdentity is stable for the same plan and distinct across plan shapes", () => {
  const specs = [
    { id: "a", objective: "do a", deps: [] },
    { id: "b", objective: "do b", deps: ["a"] },
  ];
  expect(planIdentity(specs)).toBe(planIdentity(specs.map((s) => ({ ...s }))));
  expect(planIdentity(specs)).toMatch(/^[0-9a-f]{8}$/);
  // Any structural difference — extra task, changed objective, changed deps —
  // is a different plan.
  expect(planIdentity(specs.slice(0, 1))).not.toBe(planIdentity(specs));
  expect(planIdentity([{ ...specs[0]!, objective: "do a differently" }, specs[1]!])).not.toBe(
    planIdentity(specs),
  );
  expect(planIdentity([specs[0]!, { ...specs[1]!, deps: [] }])).not.toBe(planIdentity(specs));
  // Behavior-bearing flags are identity too: a re-plan that flips verification,
  // checks, ownership, or tier must re-run — never inherit a completion produced
  // under weaker rules (verify-pass regression).
  expect(planIdentity([{ ...specs[0]!, verify: true }, specs[1]!])).not.toBe(planIdentity(specs));
  expect(planIdentity([{ ...specs[0]!, check: true }, specs[1]!])).not.toBe(planIdentity(specs));
  expect(planIdentity([{ ...specs[0]!, files: ["src/a.ts"] }, specs[1]!])).not.toBe(
    planIdentity(specs),
  );
  expect(planIdentity([{ ...specs[0]!, tier: "cheap" as const }, specs[1]!])).not.toBe(
    planIdentity(specs),
  );
  expect(planIdentity([{ ...specs[0]!, worktree: true }, specs[1]!])).not.toBe(planIdentity(specs));
  expect(planIdentity([{ ...specs[0]!, hard: true }, specs[1]!])).not.toBe(planIdentity(specs));
  expect(planIdentity([{ ...specs[0]!, agent: "review" }, specs[1]!])).not.toBe(
    planIdentity(specs),
  );
  expect(
    planIdentity([
      { ...specs[0]!, outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } },
      specs[1]!,
    ]),
  ).not.toBe(planIdentity(specs));
  expect(
    planIdentity([
      { ...specs[0]!, outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } },
      specs[1]!,
    ]),
  ).toBe(
    planIdentity([
      { ...specs[0]!, outputSchema: { properties: { ok: { type: "boolean" } }, type: "object" } },
      specs[1]!,
    ]),
  );
});

test("ids that sanitize-equal get distinct report files (no overwrite/mixup)", () => {
  // `a.b` and `a_b` both sanitize to `a_b`; a bare-slug path collided so the
  // second overwrote the first. A per-id hash keeps them distinct.
  const cwd = tmp();
  const relDot = persistTaskReport(cwd, "s", "a.b", "report for a.b");
  const relUnderscore = persistTaskReport(cwd, "s", "a_b", "report for a_b");
  expect(relDot).toBeDefined();
  expect(relUnderscore).toBeDefined();
  expect(relDot).not.toBe(relUnderscore); // distinct paths
  // Neither clobbered the other.
  expect(readTaskReport(cwd, relDot!)).toBe("report for a.b");
  expect(readTaskReport(cwd, relUnderscore!)).toBe("report for a_b");
});
