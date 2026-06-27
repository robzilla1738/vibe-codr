import { test, expect } from "bun:test";
import { addUsage, computeCost, sessionUsage, type TokenTotals } from "./usage.ts";

test("addUsage folds step usage, treating missing fields as zero", () => {
  const total: TokenTotals = { inputTokens: 0, outputTokens: 0 };
  addUsage(total, { inputTokens: 100, outputTokens: 20 });
  addUsage(total, { outputTokens: 5 });
  addUsage(total, undefined);
  expect(total).toEqual({ inputTokens: 100, outputTokens: 25 });
});

test("computeCost prices input and output per million tokens", () => {
  // $3 / 1M input, $15 / 1M output.
  const cost = computeCost(1_000_000, 1_000_000, { input: 3, output: 15 });
  expect(cost).toBeCloseTo(18, 6);
  expect(computeCost(500_000, 0, { input: 3 })).toBeCloseTo(1.5, 6);
});

test("computeCost is zero when the price is unknown", () => {
  expect(computeCost(1_000_000, 1_000_000, undefined)).toBe(0);
  expect(computeCost(1_000_000, 0, { output: 10 })).toBe(0);
});

test("sessionUsage rolls totals and cost together", () => {
  const usage = sessionUsage(
    { inputTokens: 2_000_000, outputTokens: 1_000_000 },
    { input: 1, output: 2 },
  );
  expect(usage.totalTokens).toBe(3_000_000);
  expect(usage.costUSD).toBeCloseTo(4, 6); // 2*1 + 1*2
});
