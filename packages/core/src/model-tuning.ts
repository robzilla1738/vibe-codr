import { parseModelString } from "@vibe/providers";
import type { Config } from "@vibe/config";

/**
 * Per-provider call tuning derived from config: reasoning/thinking options and
 * whether the stable system prefix should be delivered with cache markers.
 * Pure and provider-agnostic so it can be unit-tested without the AI SDK.
 */
export interface ModelTuning {
  /** AI-SDK `providerOptions` (keyed by provider id), or undefined if none. */
  providerOptions?: Record<string, Record<string, unknown>>;
  /** Deliver the system prompt as a cached message (Anthropic prompt caching). */
  cacheSystem: boolean;
}

/** Marker the AI SDK forwards as Anthropic `cache_control: {type:"ephemeral"}`. */
export const ANTHROPIC_CACHE_CONTROL = {
  anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

function providerOf(modelString: string): string {
  try {
    return parseModelString(modelString).providerId;
  } catch {
    return "";
  }
}

export function buildModelTuning(modelString: string, config: Config): ModelTuning {
  const provider = providerOf(modelString);
  const { effort, budgetTokens } = config.reasoning;
  const opts: Record<string, Record<string, unknown>> = {};

  switch (provider) {
    case "anthropic": {
      // Anthropic uses an explicit thinking budget (tokens), not an effort tier.
      if (budgetTokens) {
        opts.anthropic = { thinking: { type: "enabled", budgetTokens } };
      }
      break;
    }
    case "openai": {
      if (effort) opts.openai = { reasoningEffort: effort };
      break;
    }
    case "openrouter": {
      // OpenRouter accepts a unified reasoning block.
      if (effort || budgetTokens) {
        const reasoning: Record<string, unknown> = {};
        if (effort) reasoning.effort = effort;
        if (budgetTokens) reasoning.max_tokens = budgetTokens;
        opts.openrouter = { reasoning };
      }
      break;
    }
    default:
      break;
  }

  return {
    providerOptions: Object.keys(opts).length ? opts : undefined,
    // Caching markers are an Anthropic feature; other providers cache server-side.
    cacheSystem: config.caching.enabled && provider === "anthropic",
  };
}
