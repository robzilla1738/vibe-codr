import { test, expect } from "bun:test";
import { addUsage, computeCost, type TokenTotals } from "./usage.ts";

test("addUsage folds step usage, treating missing fields as zero", () => {
  const total: TokenTotals = { inputTokens: 0, outputTokens: 0 };
  addUsage(total, { inputTokens: 100, outputTokens: 20 });
  addUsage(total, { outputTokens: 5 });
  addUsage(total, undefined);
  expect(total).toEqual({ inputTokens: 100, outputTokens: 25 });
});

test("addUsage accumulates cached input tokens when reported", () => {
  const total: TokenTotals = { inputTokens: 0, outputTokens: 0 };
  addUsage(total, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 });
  addUsage(total, { inputTokens: 50, outputTokens: 5 }); // no cache field
  addUsage(total, { inputTokens: 50, outputTokens: 5, cachedInputTokens: 40 });
  expect(total.cachedInputTokens).toBe(120);
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

test("computeCost bills cached input at the cache-read rate", () => {
  // 1M input of which 900k were cache reads, $3/1M input, $0.30/1M cache read.
  // uncached 100k * 3 + cached 900k * 0.30 = 0.3 + 0.27 = 0.57.
  const cost = computeCost(1_000_000, 0, { input: 3, output: 15, cacheRead: 0.3 }, 900_000);
  expect(cost).toBeCloseTo(0.57, 6);
  // The old flat-input pricing would have charged 1M * 3 = $3 — ~5x more.
  expect(cost).toBeLessThan(computeCost(1_000_000, 0, { input: 3 }, 0));
});

test("computeCost falls back to the input rate when no cache rate is known", () => {
  // Without cacheRead, cached tokens still bill (at full input) — never understated.
  expect(computeCost(1_000_000, 0, { input: 3 }, 900_000)).toBeCloseTo(3, 6);
});

test("computeCost clamps cached tokens to the input total", () => {
  // A bogus cached > input must not produce negative uncached cost.
  expect(computeCost(100_000, 0, { input: 3, cacheRead: 0 }, 999_999)).toBeCloseTo(0, 6);
});
