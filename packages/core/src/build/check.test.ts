import { test, expect } from "bun:test";
import { parseCheckOutput, formatCheckResult } from "./check.ts";

test("typecheck: TS error lines counted, exit 0 with no errors passes", () => {
  const red = parseCheckOutput(
    "typecheck",
    "src/a.ts(3,1): error TS2322: Type 'x' is not assignable\nsrc/b.ts(9,5): error TS2551: nope",
    2,
  );
  expect(red.pass).toBe(false);
  expect(red.failed).toBe(2);
  expect(red.firstFailures[0]).toContain("TS2322");
  expect(parseCheckOutput("typecheck", "", 0).pass).toBe(true);
});

test("test: jest/vitest count format parsed", () => {
  const r = parseCheckOutput("test", "Tests: 3 failed, 139 passed, 142 total", 1);
  expect(r.pass).toBe(false);
  expect(r.failed).toBe(3);
  expect(r.total).toBe(142);
});

test("test: bun 'pass/fail' format parsed", () => {
  const r = parseCheckOutput("test", " 654 pass\n 0 fail\nRan 654 tests across 91 files.", 0);
  expect(r.pass).toBe(true);
  expect(r.failed).toBe(0);
  expect(r.total).toBe(654);
});

test("test: 'no tests ran' is NOT green even on exit 0", () => {
  const r = parseCheckOutput("test", "no tests found\n0 passed", 0);
  expect(r.pass).toBe(false);
  expect(r.firstFailures[0]).toContain("no tests ran");
});

test("test: a passing run with an unparseable count is NOT treated as 'no tests'", () => {
  // Go prints "ok  pkg  0.5s" with no count — a green exit must stay green.
  const r = parseCheckOutput("test", "ok  \tgithub.com/x/y\t0.512s", 0);
  expect(r.pass).toBe(true);
});

test("test: Go multi-package with a testless package (exit 0) stays GREEN", () => {
  // `go test ./...`: one package passes, one has no tests. "[no test files]" is
  // a per-package note, not a whole-run "zero tests" verdict.
  const r = parseCheckOutput(
    "test",
    "ok  \tgithub.com/x/foo\t0.512s\n?   \tgithub.com/x/bar\t[no test files]",
    0,
  );
  expect(r.pass).toBe(true);
});

test("test: an all-testless Go run (nothing ran) is still 'no tests', not green", () => {
  const r = parseCheckOutput(
    "test",
    "?   \tgithub.com/x/foo\t[no test files]\n?   \tgithub.com/x/bar\t[no test files]",
    0,
  );
  expect(r.pass).toBe(false);
  expect(r.firstFailures[0]).toContain("no tests ran");
});

test("test: exit-0 run is not flipped RED by a '<N> failed' token in log noise", () => {
  // Output contains "Batch 3 failed" / a fixture "2 failed" but the runner
  // exited 0 — the exit code is the source of truth, so this stays green.
  const r = parseCheckOutput("test", 'console.log("Batch 3 failed")\nfixture emits: 2 failed\nOK', 0);
  expect(r.pass).toBe(true);
  expect(r.failed).toBe(0);
});

test("lint: error count parsed; build: exit code is the source of truth", () => {
  const lint = parseCheckOutput("lint", "12 problems (3 errors, 9 warnings)", 1);
  expect(lint.pass).toBe(false);
  expect(lint.failed).toBe(3);

  const build = parseCheckOutput("build", "error: cannot find module 'x'", 1);
  expect(build.pass).toBe(false);
  expect(build.firstFailures[0]).toContain("cannot find module");
  expect(parseCheckOutput("build", "anything", 0).pass).toBe(true);
});

test("lint: exit-0 is not flipped RED by a scraped '<N> errors' summary", () => {
  // Biome after an autofix: "Found 3 errors (3 fixed, 0 remaining)" with exit 0.
  // The exit code is the source of truth — this is a PASS, not 3 failures.
  const r = parseCheckOutput("lint", "Found 3 errors (3 fixed, 0 remaining)", 0);
  expect(r.pass).toBe(true);
  expect(r.failed).toBe(0);
});

test("typecheck: exit-0 is not flipped RED by an 'error TS…' token in output", () => {
  // A log line quoting a prior diagnostic must not turn a passing compile red.
  const r = parseCheckOutput("typecheck", "note: previously saw error TS1234 here\nDone.", 0);
  expect(r.pass).toBe(true);
  expect(r.failed).toBe(0);
});

test("formatCheckResult renders PASS n/m and FAIL with first failures", () => {
  const pass = formatCheckResult("test", "bun test", { pass: true, failed: 0, total: 142, firstFailures: [] }, "3.2");
  expect(pass).toBe("PASS test (bun test) 142/142 in 3.2s");
  const fail = formatCheckResult(
    "test",
    "bun test",
    { pass: false, failed: 3, total: 142, firstFailures: ["✗ renders header"] },
    "3.2",
  );
  expect(fail).toContain("FAIL test (bun test) 3/142 failing");
  expect(fail).toContain("✗ renders header");
});
