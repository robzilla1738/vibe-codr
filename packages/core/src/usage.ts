import type { SessionUsage, Usage } from "@vibe/shared";
import type { ModelPrice } from "@vibe/config";

/** A running token total accumulated across a session's steps. */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
}

/** Fold a single step's usage into a running total (missing fields count as 0). */
export function addUsage(total: TokenTotals, step: Usage | undefined): void {
  if (!step) return;
  total.inputTokens += step.inputTokens ?? 0;
  total.outputTokens += step.outputTokens ?? 0;
}

/** Cost in USD for token counts at a per-1M-token price (0 when unpriced). */
export function computeCost(
  inputTokens: number,
  outputTokens: number,
  price: ModelPrice | undefined,
): number {
  if (!price) return 0;
  const inCost = price.input ? (inputTokens / 1_000_000) * price.input : 0;
  const outCost = price.output ? (outputTokens / 1_000_000) * price.output : 0;
  return inCost + outCost;
}

/** Build a `SessionUsage` snapshot from totals and the active model's price. */
export function sessionUsage(
  total: TokenTotals,
  price: ModelPrice | undefined,
): SessionUsage {
  return {
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    totalTokens: total.inputTokens + total.outputTokens,
    costUSD: computeCost(total.inputTokens, total.outputTokens, price),
  };
}
