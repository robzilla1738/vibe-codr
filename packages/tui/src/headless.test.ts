import { test, expect } from "bun:test";
import { formatDiff, formatUsage, formatJsonResult } from "./headless.ts";

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

test("formatUsage always shows cost: $0.00 for free, $ for real, ~$ for estimates", () => {
  // Free/local model → an explicit $0.00 rather than a hidden cost.
  expect(formatUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0 })).toBe(
    "15 tok · $0.00",
  );
  // Real price.
  expect(
    formatUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 1500, costUSD: 0.042 }),
  ).toContain("$0.0420");
  // Estimated price (base-model fallback) → ~$ prefix.
  expect(
    formatUsage({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 1500,
      costUSD: 0.042,
      costEstimated: true,
    }),
  ).toContain("~$0.0420");
});

test("formatUsage renders cached tokens compactly (k-suffix), matching the total", () => {
  const s = formatUsage({
    inputTokens: 5000,
    outputTokens: 100,
    totalTokens: 5100,
    costUSD: 0.03,
    cachedInputTokens: 1100,
  });
  // Both the total and the cached count use the compact `k` form — not `1100`.
  expect(s).toContain("5.1k tok");
  expect(s).toContain("1.1k cached");
  expect(s).not.toContain("1100 cached");
});

test("formatJsonResult emits a parseable result with the expected fields", () => {
  const json = formatJsonResult({
    sessionId: "ses_1",
    model: "anthropic/claude-opus-4-8",
    mode: "execute",
    text: "done",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.01 },
  });
  const parsed = JSON.parse(json) as Record<string, unknown>;
  expect(parsed.sessionId).toBe("ses_1");
  expect(parsed.model).toBe("anthropic/claude-opus-4-8");
  expect(parsed.text).toBe("done");
  expect((parsed.usage as { totalTokens: number }).totalTokens).toBe(15);
  expect(parsed.error).toBeUndefined();
});
