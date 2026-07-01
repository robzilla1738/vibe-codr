import type { CheckName, CheckSignal } from "@vibe/shared";

/**
 * Pure: distill a check's raw log into a compact signal — pass/fail, counts,
 * and the first few failures — so an agent spends one step on a verdict, not
 * twenty re-reading a truncated test log. (Ported from agentswarm codeintel.)
 */
export function parseCheckOutput(
  check: CheckName,
  raw: string,
  exitCode: number | null,
): { pass: boolean; failed: number; total: number; firstFailures: string[] } {
  const text = raw ?? "";
  const ok = exitCode === 0;
  const ls = text.split("\n");

  if (check === "typecheck") {
    const errs = ls.filter((l) => /error TS\d+|: error:|error\[/.test(l));
    return { pass: ok && errs.length === 0, failed: errs.length, total: errs.length, firstFailures: errs.slice(0, 5) };
  }

  if (check === "test") {
    // jest/vitest: "Tests: 3 failed, 139 passed, 142 total"; pytest: "3 failed,
    // 139 passed"; bun: "139 pass / 3 fail"; cargo/go too.
    let failed = num(text, /(\d+)\s+fail(?:ed)?\b/i);
    const passed = num(text, /(\d+)\s+pass(?:ed)?\b/i);
    const totalM = num(text, /(\d+)\s+total/i);
    const total = totalM || (passed != null || failed != null ? (passed ?? 0) + (failed ?? 0) : 0);
    if (failed == null) failed = ok ? 0 : Math.max(1, countErrors(ls));
    // "No tests" requires EXPLICIT evidence of zero collection. A passing
    // command that simply doesn't print a parseable count (Go `go test` → "ok
    // pkg", custom runners) must NOT be treated as "no tests" — that would turn
    // a genuinely green tree red.
    const noTests =
      total === 0 && /no tests? (ran|found|collected)|0 passed|collected 0 items|no test files/i.test(text);
    const failures = ls.filter((l) => /✕|✗|FAIL(ED)?\b|\bfailed\b|panicked|AssertionError|Error:/.test(l)).slice(0, 5);
    return {
      pass: ok && (failed ?? 0) === 0 && !noTests,
      failed: failed ?? 0,
      total,
      firstFailures: noTests ? ["no tests ran — establish a test command / add tests", ...failures] : failures,
    };
  }

  if (check === "lint") {
    const errors = num(text, /(\d+)\s+error/i) ?? (ok ? 0 : countErrors(ls));
    const problems = num(text, /(\d+)\s+problem/i) ?? errors;
    const failures = ls.filter((l) => /error|warning/i.test(l)).slice(0, 5);
    return { pass: ok && errors === 0, failed: errors, total: problems, firstFailures: failures };
  }

  // build / install: exit code is the source of truth; collect first error lines.
  const errLines = ls.filter((l) => /error|fail|cannot|unresolved|undefined reference/i.test(l)).slice(0, 5);
  const failed = ok ? 0 : Math.max(1, errLines.length);
  return { pass: ok, failed, total: failed, firstFailures: errLines };
}

function num(text: string, re: RegExp): number | null {
  const m = re.exec(text);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

function countErrors(ls: string[]): number {
  return ls.filter((l) => /\berror\b/i.test(l)).length;
}

/** Compact one-line-plus-failures rendering for the run_check tool result. */
export function formatCheckResult(
  check: CheckName,
  command: string,
  r: ReturnType<typeof parseCheckOutput>,
  durSec: string,
): string {
  const head = r.pass
    ? `PASS ${check} (${command}) ${r.total ? `${r.total - r.failed}/${r.total}` : ""} in ${durSec}s`.trim()
    : `FAIL ${check} (${command}) ${r.total ? `${r.failed}/${r.total} failing` : "exit nonzero"} in ${durSec}s`;
  return r.firstFailures.length ? `${head}\n${r.firstFailures.map((f) => `  ${f}`).join("\n")}` : head;
}

/** Render a full CheckSignal (as run by the green-gate) for prompts/notices. */
export function formatCheckSignal(sig: CheckSignal): string {
  return formatCheckResult(
    sig.check,
    sig.command,
    { pass: sig.pass, failed: sig.failed, total: sig.total, firstFailures: sig.firstFailures },
    (sig.durationMs / 1000).toFixed(1),
  );
}
