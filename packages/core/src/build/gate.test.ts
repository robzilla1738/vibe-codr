import { test, expect } from "bun:test";
import type { RepoProfile } from "@vibe/shared";
import type { Exec } from "./exec.ts";
import { pickChecks, runGate, formatGateFailure, formatGateOutcome } from "./gate.ts";

const profile = (commands: RepoProfile["commands"]): RepoProfile => ({
  greenfield: false,
  primaryLanguage: "TypeScript",
  packageManager: "bun",
  framework: null,
  commands,
  monorepo: { tool: null, packages: [] },
  git: { isRepo: true, branch: "main", dirty: false },
  conventions: [],
  manifestFiles: ["package.json"],
});

test("pickChecks: configured ∩ detected, fail-fast order", () => {
  const picked = pickChecks(profile({ test: "bun test", typecheck: "tsc", lint: "biome lint" }), [
    "build",
    "test",
    "typecheck",
  ]);
  expect(picked.map((p) => p.check)).toEqual(["typecheck", "test"]); // build not detected; lint not wanted
});

test("runGate: an already-aborted signal stops before running any check → aborted", async () => {
  const ran: string[] = [];
  const exec: Exec = async (cmd) => {
    ran.push(cmd);
    return { out: "10 pass", code: 0 };
  };
  const ctrl = new AbortController();
  ctrl.abort();
  const summary = await runGate("/x", profile({ typecheck: "tsc", test: "bun test" }), 0, {
    checks: ["typecheck", "test"],
    exec,
    signal: ctrl.signal,
  });
  expect(ran).toEqual([]); // nothing ran — aborted up front
  // Commands existed; the interrupt cut in before a verdict. That's "aborted"
  // (a terminal non-verdict), NOT "unverified" (which means no command to run).
  expect(summary.outcome).toBe("aborted");
});

test("runGate: an abort DURING a check is aborted, not a false RED", async () => {
  // The signal killed the child mid-run: exec returns nonzero, but the abort is
  // the honest reason. parseCheckOutput would bucket the nonzero exit as a real
  // failure (false RED) — the post-exec abort check must win.
  const ctrl = new AbortController();
  const exec: Exec = async () => {
    ctrl.abort();
    return { out: "Terminated", code: 143 };
  };
  const summary = await runGate("/x", profile({ typecheck: "tsc" }), 0, {
    checks: ["typecheck"],
    exec,
    signal: ctrl.signal,
  });
  expect(summary.outcome).toBe("aborted");
});

test("runGate: an abort BETWEEN checks is aborted, not a false GREEN, and skips the rest", async () => {
  // The first check passes cleanly (exit 0), then the user hits Esc before the
  // next check. Bucketing the passed check as GREEN would be a false verdict; the
  // second command must never run.
  const ran: string[] = [];
  const ctrl = new AbortController();
  const exec: Exec = async (cmd) => {
    ran.push(cmd);
    ctrl.abort();
    return { out: "10 pass\n0 fail", code: 0 };
  };
  const summary = await runGate("/x", profile({ typecheck: "tsc", test: "bun test" }), 0, {
    checks: ["typecheck", "test"],
    exec,
    signal: ctrl.signal,
  });
  expect(summary.outcome).toBe("aborted"); // not green, even though the check that ran passed
  expect(ran).toEqual(["tsc"]); // the second check never ran
});

test("runGate: the abort signal is forwarded to exec (abortable mid-check)", async () => {
  let received: AbortSignal | undefined;
  const exec: Exec = async (_cmd, opts) => {
    received = opts.signal;
    return { out: "10 pass", code: 0 };
  };
  const ctrl = new AbortController();
  await runGate("/x", profile({ typecheck: "tsc" }), 0, { checks: ["typecheck"], exec, signal: ctrl.signal });
  expect(received).toBe(ctrl.signal);
});

test("runGate: a non-positive timeout is coerced to the default (no wedge)", async () => {
  let seenTimeout: number | undefined;
  const exec: Exec = async (_cmd, opts) => {
    seenTimeout = opts.timeoutSec;
    return { out: "10 pass", code: 0 };
  };
  await runGate("/x", profile({ typecheck: "tsc" }), 0, { checks: ["typecheck"], exec, timeoutSec: 0 });
  expect(seenTimeout).toBe(600); // coerced away from the wedge-inducing 0
});

test("runGate: green when every check passes; commands actually run", async () => {
  const ran: string[] = [];
  const exec: Exec = async (cmd) => {
    ran.push(cmd);
    return { out: " 10 pass\n 0 fail", code: 0 };
  };
  const summary = await runGate("/x", profile({ typecheck: "tsc --noEmit", test: "bun test" }), 0, {
    checks: ["typecheck", "test"],
    exec,
  });
  expect(summary.outcome).toBe("green");
  expect(summary.checks).toHaveLength(2);
  expect(ran).toEqual(["tsc --noEmit", "bun test"]);
});

test("runGate: fails fast — a red typecheck skips the test run", async () => {
  const ran: string[] = [];
  const exec: Exec = async (cmd) => {
    ran.push(cmd);
    return { out: "src/a.ts(1,1): error TS2304: Cannot find name 'x'", code: 2 };
  };
  const summary = await runGate("/x", profile({ typecheck: "tsc", test: "bun test" }), 1, {
    checks: ["typecheck", "test"],
    exec,
  });
  expect(summary.outcome).toBe("red");
  expect(ran).toEqual(["tsc"]); // test never ran
  expect(summary.round).toBe(1);
});

test("runGate: no detected commands → unverified, never green", async () => {
  const summary = await runGate("/x", profile({}), 0, { checks: ["typecheck", "test"] });
  expect(summary.outcome).toBe("unverified");
  expect(formatGateOutcome(summary)).toContain("UNVERIFIED");
  expect(formatGateOutcome(summary)).toContain("not machine-verified");
});

test("formatGateFailure carries per-check verdicts, round budget, and the honesty framing", async () => {
  const exec: Exec = async () => ({ out: "Tests: 3 failed, 139 passed, 142 total\n✗ renders header", code: 1 });
  const summary = await runGate("/x", profile({ test: "bun test" }), 0, { checks: ["test"], exec });
  const prompt = formatGateFailure(summary, 2);
  expect(prompt).toContain("RED (fix round 1/2)");
  expect(prompt).toContain("FAIL test (bun test) 3/142 failing");
  expect(prompt).toContain("Do not claim done");
});

test("formatGateOutcome renders a compact green line", async () => {
  const exec: Exec = async () => ({ out: " 142 pass\n 0 fail\n142 total", code: 0 });
  const summary = await runGate("/x", profile({ test: "bun test" }), 0, { checks: ["test"], exec });
  expect(formatGateOutcome(summary)).toBe("Gate: GREEN — test ✓ 142/142");
});

test("formatGateOutcome renders ABORTED on its own line, never a per-check list", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const summary = await runGate("/x", profile({ typecheck: "tsc" }), 0, {
    checks: ["typecheck"],
    signal: ctrl.signal,
  });
  const line = formatGateOutcome(summary);
  expect(line).toContain("ABORTED");
  expect(line).toContain("not machine-verified");
  expect(line).not.toContain("✓"); // no misleading "typecheck ✓" from the parts map
});
