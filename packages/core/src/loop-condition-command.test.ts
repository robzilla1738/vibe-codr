import { expect, test } from "bun:test";
import { evaluateLoopCommandCondition } from "./loop-condition-command.ts";

test("command condition: exit 0 is satisfied without exposing output", async () => {
  const verdict = await evaluateLoopCommandCondition({
    cwd: "/work",
    command: "test -f ready",
    signal: new AbortController().signal,
    run: async () => ({ code: 0, output: "secret diagnostic\n" }),
  });
  expect(verdict).toEqual({ done: true, reason: "command exited 0" });
  expect(verdict.reason).not.toContain("secret");
});

test("command condition: ordinary nonzero is not yet, not an evaluator error", async () => {
  const verdict = await evaluateLoopCommandCondition({
    cwd: "/work",
    command: "test -f ready",
    signal: new AbortController().signal,
    run: async () => ({ code: 1, output: "not ready" }),
  });
  expect(verdict).toEqual({ done: false, reason: "command exited 1" });
});

test("command condition: containment and timeout errors propagate to the bounded controller", async () => {
  const failure = new Error("read-only command sandbox unavailable");
  await expect(
    evaluateLoopCommandCondition({
      cwd: "/work",
      command: "true",
      signal: new AbortController().signal,
      run: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
});
