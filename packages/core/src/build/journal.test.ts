import { test, expect } from "bun:test";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOrchestrationEvent,
  persistTaskReport,
  readTaskReport,
  loadCompletedTasks,
} from "./journal.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "vibe-journal-"));

test("completed tasks replay with their persisted reports; in-flight tasks re-run", async () => {
  const cwd = tmp();
  const ses = "ses_1";
  appendOrchestrationEvent(cwd, ses, { type: "task-started", at: 1, id: "t1", objective: "build a", deps: [] });
  const reportPath = persistTaskReport(cwd, ses, "t1", "full report of t1");
  expect(reportPath).toBeDefined();
  appendOrchestrationEvent(cwd, ses, {
    type: "task-finished", at: 2, id: "t1", objective: "build a", outcome: "completed", attempts: 1,
    handoff: { keyFacts: ["a done"], filesTouched: ["a.ts"], openQuestions: [] },
    ...(reportPath ? { reportPath } : {}),
  });
  // t2 started but never finished — must NOT be seeded.
  appendOrchestrationEvent(cwd, ses, { type: "task-started", at: 3, id: "t2", objective: "build b", deps: ["t1"] });

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
    type: "task-finished", at: 1, id: "bad", objective: "x", outcome: "failed", attempts: 2,
  });
  appendFileSync(join(cwd, ".vibe", "orchestration", `${ses}.jsonl`), '{"type":"task-fin');
  expect(loadCompletedTasks(cwd, ses)).toEqual([]);
});

test("missing journal loads empty; missing report degrades to a placeholder", () => {
  const cwd = tmp();
  expect(loadCompletedTasks(cwd, "nope")).toEqual([]);
  const ses = "ses_3";
  appendOrchestrationEvent(cwd, ses, {
    type: "task-finished", at: 1, id: "t", objective: "x", outcome: "completed", attempts: 1,
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
