import type { Usage } from "@vibe/shared";
import type { ModelPrice } from "@vibe/config";

/** A running token total accumulated across a session's steps. */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  /** Cumulative input tokens served from the provider's prompt cache. */
  cachedInputTokens?: number;
}

/** Fold a single step's usage into a running total (missing fields count as 0). */
export function addUsage(total: TokenTotals, step: Usage | undefined): void {
  if (!step) return;
  total.inputTokens += step.inputTokens ?? 0;
  total.outputTokens += step.outputTokens ?? 0;
  if (step.cachedInputTokens) {
    total.cachedInputTokens = (total.cachedInputTokens ?? 0) + step.cachedInputTokens;
  }
}

/**
 * Cost in USD for a step's tokens at a per-1M-token price (0 when unpriced).
 * Cache-aware: `cachedInputTokens` (a subset of `inputTokens`) is billed at the
 * cache-read rate (~0.1× on Anthropic), which the prior flat-input pricing
 * overstated several-fold — enough to mis-trip a `budget.onExceed=stop` guard.
 * Falls back to the full input rate when no cache rate is known, so cost is
 * never understated.
 */
export function computeCost(
  inputTokens: number,
  outputTokens: number,
  price: ModelPrice | undefined,
  cachedInputTokens = 0,
  cacheWriteTokens = 0,
): number {
  if (!price) return 0;
  const writes = Math.max(0, cacheWriteTokens);
  // `inputTokens` arrives as the folded superset (uncached + cache reads +
  // cache writes); peel the specially-priced slices off it.
  const cached = Math.min(Math.max(0, cachedInputTokens), inputTokens);
  const uncached = Math.max(0, inputTokens - cached - writes);
  const inCost = price.input ? (uncached / 1_000_000) * price.input : 0;
  // Cached reads bill at the cache-read rate; fall back to the full input rate.
  const cacheRate = price.cacheRead ?? price.input;
  const cacheCost = cacheRate ? (cached / 1_000_000) * cacheRate : 0;
  // Cache WRITES bill at the cache-write rate (Anthropic: 1.25x input); fall
  // back to the input rate — never understate to zero like before, when
  // cache-creation tokens were invisible to cost entirely.
  const writeRate = price.cacheWrite ?? price.input;
  const writeCost = writeRate ? (writes / 1_000_000) * writeRate : 0;
  const outCost = price.output ? (outputTokens / 1_000_000) * price.output : 0;
  return inCost + cacheCost + writeCost + outCost;
}
