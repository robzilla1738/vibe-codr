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
  /** Mark the tool block with a cache breakpoint (tools are large and stable —
   * without this every step re-bills every schema). Anthropic only. */
  cacheTools: boolean;
  /** Mark the trailing conversation message so each turn's prefix is a cache
   * hit for the next. Anthropic only. */
  cacheConversation: boolean;
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

/**
 * Whether the provider reports cached-prompt tokens DISJOINT from `inputTokens`
 * (input EXCLUDES the cached read) rather than as a subset of it. Anthropic does
 * this — `input_tokens` is the new/uncached input and `cache_read_input_tokens`
 * is separate — so a cache hit would understate cost (the flat-input pricing in
 * `computeCost` assumes cached ⊆ input), the live context %, and the compaction
 * trigger unless the caller folds the two into a superset. OpenAI-family
 * providers already include cached in input, so no fold is needed there.
 */
export function cacheTokensDisjointFromInput(modelString: string): boolean {
  return providerOf(modelString) === "anthropic";
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

  // Caching markers are an Anthropic feature; other providers cache server-side.
  // Budget check: system(1) + tools(1) + conversation(1) = 3 of Anthropic's 4
  // allowed breakpoints — the validator never has to drop one.
  const anthropicCaching = config.caching.enabled && provider === "anthropic";
  return {
    providerOptions: Object.keys(opts).length ? opts : undefined,
    cacheSystem: anthropicCaching,
    cacheTools: anthropicCaching && config.caching.cacheTools,
    cacheConversation: anthropicCaching && config.caching.cacheConversation,
  };
}
