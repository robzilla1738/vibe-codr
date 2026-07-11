import { ModelResolutionError } from "@vibe/shared";
import type { ModelRef } from "./types.ts";

/**
 * Parse a model string into `{ providerId, modelId }`, splitting on the FIRST
 * slash so aggregator ids keep their internal slashes:
 *   "anthropic/claude-opus-4-8" -> { anthropic, claude-opus-4-8 }
 *   "openrouter/anthropic/claude-..." -> { openrouter, anthropic/claude-... }
 *   "lmstudio/qwen2.5-coder" -> { lmstudio, qwen2.5-coder }
 */
export function parseModelString(modelString: string): ModelRef {
  const trimmed = modelString.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new ModelResolutionError(modelString, 'expected "<provider>/<model-id>"');
  }
  return {
    providerId: trimmed.slice(0, slash),
    modelId: trimmed.slice(slash + 1),
  };
}

/** Inverse of {@link parseModelString}. */
export function formatModelString(ref: ModelRef): string {
  return `${ref.providerId}/${ref.modelId}`;
}
