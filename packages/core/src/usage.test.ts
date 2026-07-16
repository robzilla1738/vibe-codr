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

test("computeCost bills cache WRITES at the cache-write rate (peeled off the input superset)", () => {
  // 1M input superset = 100k uncached + 200k cache reads + 700k cache writes.
  // $3/1M input, $0.30/1M read, $3.75/1M write (Anthropic 1.25x).
  // 100k*3 + 200k*0.30 + 700k*3.75 = 0.3 + 0.06 + 2.625 = 2.985.
  const cost = computeCost(
    1_000_000,
    0,
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    200_000,
    700_000,
  );
  expect(cost).toBeCloseTo(2.985, 6);
});

test("computeCost falls back to the input rate for cache writes when unpriced", () => {
  // No cacheWrite rate → writes bill at full input (never silently free).
  // 1M superset, 300k writes, no reads: 700k*3 + 300k*3 = 3.0.
  expect(computeCost(1_000_000, 0, { input: 3 }, 0, 300_000)).toBeCloseTo(3, 6);
});

// Mirrors a models.dev tiered model (gemini-3.1-pro-preview): base rates below
// 200k prompt tokens, higher rates above.
const tiered = {
  input: 2,
  output: 12,
  cacheRead: 0.2,
  tiers: [{ threshold: 200_000, input: 4, output: 18, cacheRead: 0.4 }],
};

test("computeCost bills the base rate for a prompt AT or BELOW the tier threshold", () => {
  // 100k input + 50k output, both under the 200k threshold → base rates.
  // 100k*2 + 50k*12 = 0.2 + 0.6 = 0.8.
  expect(computeCost(100_000, 50_000, tiered)).toBeCloseTo(0.8, 6);
  // Exactly AT the threshold is still base — the tier is for prompts strictly over.
  // 200k*2 = 0.4.
  expect(computeCost(200_000, 0, tiered)).toBeCloseTo(0.4, 6);
});

test("computeCost bills the tier rate for a prompt OVER the threshold — whole request", () => {
  // 300k input + 50k output, prompt over 200k → the WHOLE request reprices.
  // 300k*4 + 50k*18 = 1.2 + 0.9 = 2.1.
  expect(computeCost(300_000, 50_000, tiered)).toBeCloseTo(2.1, 6);
  // Strictly more than the base rate would have charged (300k*2 + 50k*12 = 1.2).
  expect(computeCost(300_000, 50_000, tiered)).toBeGreaterThan(
    computeCost(300_000, 50_000, { input: 2, output: 12, cacheRead: 0.2 }),
  );
});

test("computeCost prices cache read/write slices at the TIER's cache rates over the threshold", () => {
  // Claude-4.6-via-requesty shape: every slice has a tier rate.
  const price = {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    tiers: [{ threshold: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 }],
  };
  // 1M superset over 200k = 100k uncached + 200k reads + 700k writes.
  // 100k*6 + 200k*0.6 + 700k*7.5 = 0.6 + 0.12 + 5.25 = 5.97 (all tier rates).
  expect(computeCost(1_000_000, 0, price, 200_000, 700_000)).toBeCloseTo(5.97, 6);
  // Under the threshold the SAME slices bill at base: 150k superset =
  // 50k uncached + 50k reads + 50k writes → 50k*3 + 50k*0.3 + 50k*3.75 = 0.3525.
  expect(computeCost(150_000, 0, price, 50_000, 50_000)).toBeCloseTo(0.3525, 6);
});

test("computeCost: a rate the tier omits inherits the base rate over the threshold", () => {
  // gpt-5.5 shape: the tier reprices input/output/cacheRead but NOT cacheWrite,
  // so cache writes must fall back to the base cacheWrite rate above the threshold.
  const price = {
    input: 2,
    output: 12,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    tiers: [{ threshold: 200_000, input: 4, output: 18, cacheRead: 0.4 }],
  };
  // 300k superset over 200k = 100k uncached + 100k reads + 100k writes.
  // 100k*4 (tier) + 100k*0.4 (tier) + 100k*2.5 (base fallback) = 0.4 + 0.04 + 0.25 = 0.69.
  expect(computeCost(300_000, 0, price, 100_000, 100_000)).toBeCloseTo(0.69, 6);
});

test("computeCost ignores an empty tier list — a huge prompt stays at the base rate", () => {
  // No applicable tier → base pricing, however large the prompt.
  expect(computeCost(5_000_000, 0, { input: 3, tiers: [] })).toBeCloseTo(15, 6);
});
