import type { Usage } from "@vibe/shared";
import type { ModelPrice } from "@vibe/config";
import type { PricingTier } from "@vibe/providers";

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

export type { PricingTier };

/** A price that may carry long-context tiers (they ride on the catalog price
 * object; the static `ModelPrice` type doesn't declare them, so widen here). */
type TieredPrice = ModelPrice & { tiers?: PricingTier[] };

/**
 * Pick the applicable long-context tier for a prompt of `promptTokens` tokens:
 * the highest-threshold tier the prompt strictly EXCEEDS (models.dev prices a
 * request that runs "over" the threshold). Providers price the WHOLE request at
 * the tier's rates once the prompt crosses it, so this returns a single tier
 * whose rates replace the base rates below. Robust to unsorted tier lists.
 */
function selectTier(
  tiers: PricingTier[] | undefined,
  promptTokens: number,
): PricingTier | undefined {
  if (!tiers?.length) return undefined;
  let chosen: PricingTier | undefined;
  for (const t of tiers) {
    if (promptTokens > t.threshold && (!chosen || t.threshold > chosen.threshold)) {
      chosen = t;
    }
  }
  return chosen;
}

/**
 * Cost in USD for a step's tokens at a per-1M-token price (0 when unpriced).
 * Cache-aware: `cachedInputTokens` (a subset of `inputTokens`) is billed at the
 * cache-read rate (~0.1× on Anthropic), which the prior flat-input pricing
 * overstated several-fold — enough to mis-trip a `budget.onExceed=stop` guard.
 * Falls back to the full input rate when no cache rate is known, so cost is
 * never understated.
 *
 * Long-context aware: `inputTokens` here is the folded prompt superset (uncached
 * + cache reads + cache writes) = the step's real context size, so it IS the
 * prompt-token count that selects the pricing tier. A prompt over a tier's
 * threshold reprices EVERY slice — input, output, cache read, cache write — at
 * the tier's rates (a rate the tier omits inherits the base rate). That matches
 * how Google/OpenAI/xAI bill a long-context request: the whole request, output
 * included, steps up once the prompt crosses the line. Selecting per step (not
 * per turn) is correct — a turn that grows past the threshold mid-run prices its
 * later, longer steps at the tier rate and its earlier ones at base.
 */
export function computeCost(
  inputTokens: number,
  outputTokens: number,
  price: TieredPrice | undefined,
  cachedInputTokens = 0,
  cacheWriteTokens = 0,
): number {
  if (!price) return 0;
  const writes = Math.max(0, cacheWriteTokens);
  // `inputTokens` arrives as the folded superset (uncached + cache reads +
  // cache writes); peel the specially-priced slices off it.
  const cached = Math.min(Math.max(0, cachedInputTokens), inputTokens);
  const uncached = Math.max(0, inputTokens - cached - writes);
  // The prompt superset selects the tier; a tier's rates override the base, and
  // any rate the tier leaves unset falls back to the base (untiered) rate.
  const tier = selectTier(price.tiers, inputTokens);
  const inputRate = tier?.input ?? price.input;
  const outputRate = tier?.output ?? price.output;
  const cacheReadRate = tier?.cacheRead ?? price.cacheRead;
  const cacheWriteRate = tier?.cacheWrite ?? price.cacheWrite;
  const inCost = inputRate ? (uncached / 1_000_000) * inputRate : 0;
  // Cached reads bill at the cache-read rate; fall back to the full input rate.
  const cacheRate = cacheReadRate ?? inputRate;
  const cacheCost = cacheRate ? (cached / 1_000_000) * cacheRate : 0;
  // Cache WRITES bill at the cache-write rate (Anthropic: 1.25x input); fall
  // back to the input rate — never understate to zero like before, when
  // cache-creation tokens were invisible to cost entirely.
  const writeRate = cacheWriteRate ?? inputRate;
  const writeCost = writeRate ? (writes / 1_000_000) * writeRate : 0;
  const outCost = outputRate ? (outputTokens / 1_000_000) * outputRate : 0;
  return inCost + cacheCost + writeCost + outCost;
}
