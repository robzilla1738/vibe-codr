import { test, expect } from "bun:test";
import { formatDiff, formatUsage } from "./headless.ts";

test("formatDiff prefixes additions, deletions, and context distinctly", () => {
  // ansi colors are disabled when stdout is not a TTY (test env), so the
  // output is the plain text — we assert the structure survives.
  const out = formatDiff(" a\n-b\n+B\n…");
  const lines = out.split("\n");
  expect(lines[1]).toContain("-b");
  expect(lines[2]).toContain("+B");
  expect(lines[3]).toContain("…");
});

test("formatDiff returns empty string for an empty diff", () => {
  expect(formatDiff("")).toBe("");
});

test("formatUsage shows tokens and omits cost when unpriced", () => {
  expect(formatUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0 })).toBe(
    "15 tok",
  );
  expect(
    formatUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 1500, costUSD: 0.042 }),
  ).toContain("$0.0420");
});
