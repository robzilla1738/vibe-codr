import type { CheckName, CheckSignal, GateSummary, RepoProfile } from "@vibe/shared";
import type { Exec } from "./exec.ts";
import { bunExec } from "./exec.ts";
import { formatCheckSignal, parseCheckOutput } from "./check.ts";

/**
 * The green-gate's engine-independent core: pick the profile's runnable checks,
 * run them for real, and distill the outcome. The ENGINE owns when to gate
 * (after a mutating execute turn) and what to do on red (enqueue bounded fix
 * turns); this module owns what "green" means. Honesty invariants:
 *   - no trustworthy check command → "unverified", never green;
 *   - checks run in fail-fast order (typecheck → test → build → lint) so a
 *     broken tree costs one cheap check, not a full test run;
 *   - output is parsed to compact signals — the model never sees raw log spew.
 */

/** Fail-fast execution order: cheapest, highest-signal checks first. */
const CHECK_ORDER: CheckName[] = ["typecheck", "test", "build", "lint"];

/** The checks this gate can actually run: configured set ∩ detected commands,
 * in fail-fast order. */
export function pickChecks(profile: RepoProfile, wanted: CheckName[]): { check: CheckName; command: string }[] {
  const want = new Set(wanted);
  const out: { check: CheckName; command: string }[] = [];
  for (const check of CHECK_ORDER) {
    const command = profile.commands[check];
    if (want.has(check) && command) out.push({ check, command });
  }
  return out;
}

export interface GateOptions {
  /** Which checks to run (intersected with the profile's detected commands). */
  checks: CheckName[];
  /** Per-check wall clock (seconds). A hung watcher must not wedge the gate. */
  timeoutSec?: number;
  signal?: AbortSignal;
  exec?: Exec;
}

/**
 * Run the gate once against a quiescent tree. Stops at the first failing check
 * (fail-fast — the remaining checks would only add noise to the fix prompt).
 */
export async function runGate(
  cwd: string,
  profile: RepoProfile,
  round: number,
  opts: GateOptions,
): Promise<GateSummary> {
  const runnable = pickChecks(profile, opts.checks);
  if (!runnable.length) return { outcome: "unverified", checks: [], round };
  const exec = opts.exec ?? bunExec();
  const checks: CheckSignal[] = [];
  for (const { check, command } of runnable) {
    // Abort is a terminal NON-verdict, never a verdict. A bare `break` here fell
    // through to the green/red (or "unverified") bucketing below, so an Esc
    // between checks read as a false GREEN (the checks that DID run all passed)
    // and an Esc before the first check read as a false "unverified" — both
    // dishonest. Commands existed and the work is simply unverified-by-interrupt.
    if (opts.signal?.aborted) return { outcome: "aborted", checks, round };
    const started = Date.now();
    const r = await exec(command, {
      cwd,
      // A non-positive timeout would disable the kill timer in bunExec and let a
      // hung watcher wedge the gate forever; coerce anything ≤ 0 to the default.
      timeoutSec: opts.timeoutSec && opts.timeoutSec > 0 ? opts.timeoutSec : 600,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    // The abort may have KILLED this run mid-flight (SIGTERM → nonzero exit).
    // parseCheckOutput would bucket that killed run as a real failure (false RED),
    // so check the signal BEFORE parsing: an interrupt is the honest verdict.
    if (opts.signal?.aborted) return { outcome: "aborted", checks, round };
    const parsed = parseCheckOutput(check, r.out, r.code);
    checks.push({ check, command, ...parsed, durationMs: Date.now() - started });
    if (!parsed.pass) break; // fail fast
  }
  // Guard the window between the last exec and bucketing too — an abort that
  // lands here is still a non-verdict, not the green/red the checks imply.
  if (opts.signal?.aborted) return { outcome: "aborted", checks, round };
  if (!checks.length) return { outcome: "unverified", checks: [], round };
  return { outcome: checks.every((c) => c.pass) ? "green" : "red", checks, round };
}

/** Render a red gate as the fix-turn prompt: structured per-check failures the
 * model acts on in one read, with the honesty framing built in. */
export function formatGateFailure(summary: GateSummary, maxRounds: number): string {
  const failing = summary.checks.filter((c) => !c.pass);
  const lines = [
    `The engine ran this repo's real checks after your changes and the tree is RED (fix round ${summary.round + 1}/${maxRounds}):`,
    "",
    ...summary.checks.map((c) => formatCheckSignal(c)),
    "",
    "Fix the failures above, then re-verify with `run_check`. Do not re-run the same approach verbatim if it already failed — diagnose first. Do not claim done while any check is red.",
  ];
  if (!failing.length) lines.push("(no per-check detail was parseable — run the commands yourself to see the failures)");
  return lines.join("\n");
}

/** One-line gate outcome for notices / the UI. */
export function formatGateOutcome(summary: GateSummary): string {
  if (summary.outcome === "unverified") {
    return "Gate: UNVERIFIED — no build/test command detected, so the work was not machine-verified.";
  }
  // ABORTED renders on its own line — it must NOT fall into the per-check parts
  // map below, which would print a misleading "typecheck ✓" list for checks the
  // interrupt cut short.
  if (summary.outcome === "aborted") {
    return "Gate: ABORTED — interrupted before a verdict; work not machine-verified.";
  }
  const parts = summary.checks.map((c) =>
    c.pass ? `${c.check} ✓${c.total ? ` ${c.total - c.failed}/${c.total}` : ""}` : `${c.check} ✗ ${c.failed} failing`,
  );
  return `Gate: ${summary.outcome.toUpperCase()} — ${parts.join(" · ")}`;
}
