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

/**
 * Providers whose models reason — either because vibe-codr forwards an effort/
 * budget hint (anthropic, openai, xai, openrouter) or because the model reasons
 * natively (codex, deepseek-reasoner). Used only to decide whether to warn that
 * `/reasoning` will be ignored (e.g. on local Ollama / LM Studio models).
 */
export const REASONING_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "codex",
  "xai",
  "openrouter",
  "deepseek",
]);

/** Map an effort tier to an Anthropic thinking budget (tokens). */
const EFFORT_BUDGET: Record<"low" | "medium" | "high", number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
};

/**
 * Whether setting reasoning effort has any effect for this model's provider.
 * Used to warn the user when `/reasoning` is set on a model that ignores it
 * (e.g. local Ollama / LM Studio models).
 */
export function reasoningSupported(modelString: string): boolean {
  return REASONING_PROVIDERS.has(providerOf(modelString));
}

export function buildModelTuning(modelString: string, config: Config): ModelTuning {
  const provider = providerOf(modelString);
  const { effort, budgetTokens } = config.reasoning;
  const opts: Record<string, Record<string, unknown>> = {};

  switch (provider) {
    case "anthropic": {
      // Anthropic uses an explicit thinking budget (tokens). Honor an explicit
      // budget, else derive one from the effort tier so `/reasoning <tier>`
      // works uniformly across providers.
      const budget = budgetTokens ?? (effort ? EFFORT_BUDGET[effort] : undefined);
      if (budget) {
        opts.anthropic = { thinking: { type: "enabled", budgetTokens: budget } };
      }
      break;
    }
    // OpenAI takes an effort tier directly. (Codex/DeepSeek reason natively, and
    // xai/openrouter now route through openai-compatible, which doesn't accept the
    // native reasoning options — so for those the model reasons at its default.)
    case "openai": {
      if (effort) opts[provider] = { reasoningEffort: effort };
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
