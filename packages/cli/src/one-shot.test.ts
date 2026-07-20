import { expect, test } from "bun:test";
import { oneShotProcessExitCode } from "./index.ts";

test("ordinary one-shot exit behavior remains compatible", () => {
  expect(oneShotProcessExitCode({ ok: true, engineFailed: false }, false)).toBe(0);
  expect(oneShotProcessExitCode({ ok: false, engineFailed: false }, false)).toBe(1);
  expect(
    oneShotProcessExitCode(
      { ok: true, engineFailed: false, goalCompletionStatus: "met-unverified" },
      false,
    ),
  ).toBe(0);
});

test("strict one-shot exits distinguish goal incompleteness from engine failure", () => {
  expect(
    oneShotProcessExitCode(
      { ok: true, engineFailed: false, goalCompletionStatus: "verified" },
      true,
    ),
  ).toBe(0);
  for (const goalCompletionStatus of ["met-unverified", "paused", "unmet"] as const) {
    expect(
      oneShotProcessExitCode({ ok: true, engineFailed: false, goalCompletionStatus }, true),
    ).toBe(2);
  }
  expect(oneShotProcessExitCode({ ok: true, engineFailed: false }, true)).toBe(2);
  expect(
    oneShotProcessExitCode(
      { ok: false, engineFailed: true, goalCompletionStatus: "verified" },
      true,
    ),
  ).toBe(1);
});
