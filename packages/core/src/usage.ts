import type { ModelUsage, Usage } from "@vibe/shared";
import type { ModelPrice } from "@vibe/config";
import type { PricingTier } from "@vibe/providers";

/** A running token total accumulated across a session's steps. */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  /** Cumulative input tokens served from the provider's prompt cache. */
  cachedInputTokens?: number;
  /** Cumulative input tokens written into a provider prompt cache. */
  cacheWriteTokens?: number;
  steps?: number;
  turns?: number;
  providerLatencyMs?: number;
  byModel?: Record<string, ModelUsage>;
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

/** A complete zero bucket. Keeping every counter explicit makes persisted and
 * wire snapshots easy to sum without optional-field ambiguity. */
export function emptyModelUsage(legacyAttribution = false): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    steps: 0,
    turns: 0,
    providerLatencyMs: 0,
    costUSD: 0,
    actualCostUSD: 0,
    ...(legacyAttribution ? { legacyAttribution: true } : {}),
  };
}

export function cloneModelUsage(
  byModel: Readonly<Record<string, ModelUsage>> | undefined,
): Record<string, ModelUsage> {
  return Object.fromEntries(
    Object.entries(byModel ?? {}).map(([model, usage]) => [model, { ...usage }]),
  );
}

/** Fold one provider step into the model that was resolved for its turn. */
export function addModelStep(
  byModel: Record<string, ModelUsage>,
  model: string,
  step: Usage | undefined,
  cacheWriteTokens: number,
  costUSD: number,
  estimated: boolean,
): void {
  const bucket = (byModel[model] ??= emptyModelUsage());
  const input = step?.inputTokens ?? 0;
  const output = step?.outputTokens ?? 0;
  bucket.inputTokens += input;
  bucket.outputTokens += output;
  bucket.totalTokens += input + output;
  bucket.cachedInputTokens += step?.cachedInputTokens ?? 0;
  bucket.cacheWriteTokens += Math.max(0, cacheWriteTokens);
  bucket.steps += 1;
  bucket.costUSD += Math.max(0, costUSD);
  if (estimated && costUSD > 0) bucket.costEstimated = true;
  else bucket.actualCostUSD = (bucket.actualCostUSD ?? 0) + Math.max(0, costUSD);
}

/** Settle the non-tool provider time and one turn against the captured model. */
export function settleModelTurn(
  byModel: Record<string, ModelUsage>,
  model: string,
  providerLatencyMs: number,
): void {
  const bucket = (byModel[model] ??= emptyModelUsage());
  bucket.turns += 1;
  bucket.providerLatencyMs += Math.max(0, providerLatencyMs);
}

/** Positive per-model delta between two cumulative maps. Used for retained child
 * sessions so every continuation folds once and stays in the child's models. */
export function diffModelUsage(
  current: Readonly<Record<string, ModelUsage>>,
  baseline: Readonly<Record<string, ModelUsage>>,
): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = {};
  for (const [model, now] of Object.entries(current)) {
    const before = baseline[model] ?? emptyModelUsage();
    const delta = emptyModelUsage();
    delta.inputTokens = Math.max(0, now.inputTokens - before.inputTokens);
    delta.outputTokens = Math.max(0, now.outputTokens - before.outputTokens);
    delta.totalTokens = delta.inputTokens + delta.outputTokens;
    delta.cachedInputTokens = Math.max(0, now.cachedInputTokens - before.cachedInputTokens);
    delta.cacheWriteTokens = Math.max(0, now.cacheWriteTokens - before.cacheWriteTokens);
    delta.steps = Math.max(0, now.steps - before.steps);
    delta.turns = Math.max(0, now.turns - before.turns);
    delta.providerLatencyMs = Math.max(0, now.providerLatencyMs - before.providerLatencyMs);
    delta.costUSD = Math.max(0, now.costUSD - before.costUSD);
    delta.actualCostUSD = Math.max(0, (now.actualCostUSD ?? 0) - (before.actualCostUSD ?? 0));
    if (delta.costUSD > delta.actualCostUSD) delta.costEstimated = true;
    if (!baseline[model] && now.legacyAttribution) delta.legacyAttribution = true;
    if (
      delta.inputTokens ||
      delta.outputTokens ||
      delta.cachedInputTokens ||
      delta.cacheWriteTokens ||
      delta.steps ||
      delta.turns ||
      delta.providerLatencyMs ||
      delta.costUSD
    ) {
      out[model] = delta;
    }
  }
  return out;
}

export function addModelUsage(
  target: Record<string, ModelUsage>,
  delta: Readonly<Record<string, ModelUsage>>,
): void {
  for (const [model, addition] of Object.entries(delta)) {
    const bucket = (target[model] ??= emptyModelUsage());
    bucket.inputTokens += addition.inputTokens;
    bucket.outputTokens += addition.outputTokens;
    bucket.totalTokens = bucket.inputTokens + bucket.outputTokens;
    bucket.cachedInputTokens += addition.cachedInputTokens;
    bucket.cacheWriteTokens += addition.cacheWriteTokens;
    bucket.steps += addition.steps;
    bucket.turns += addition.turns;
    bucket.providerLatencyMs += addition.providerLatencyMs;
    bucket.costUSD += addition.costUSD;
    bucket.actualCostUSD = (bucket.actualCostUSD ?? 0) + (addition.actualCostUSD ?? 0);
    if (addition.costEstimated) bucket.costEstimated = true;
    if (addition.legacyAttribution) bucket.legacyAttribution = true;
  }
}

/** Sum buckets into the compatibility totals carried at SessionUsage's top level. */
export function sumModelUsage(byModel: Readonly<Record<string, ModelUsage>>): ModelUsage {
  const total = emptyModelUsage();
  for (const bucket of Object.values(byModel)) {
    total.inputTokens += bucket.inputTokens;
    total.outputTokens += bucket.outputTokens;
    total.cachedInputTokens += bucket.cachedInputTokens;
    total.cacheWriteTokens += bucket.cacheWriteTokens;
    total.steps += bucket.steps;
    total.turns += bucket.turns;
    total.providerLatencyMs += bucket.providerLatencyMs;
    total.costUSD += bucket.costUSD;
    total.actualCostUSD = (total.actualCostUSD ?? 0) + (bucket.actualCostUSD ?? 0);
    if (bucket.costEstimated) total.costEstimated = true;
    if (bucket.legacyAttribution) total.legacyAttribution = true;
  }
  total.totalTokens = total.inputTokens + total.outputTokens;
  return total;
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
