import type { ModelInfo } from "./types.ts";

/**
 * Published model facts for providers that models.dev doesn't list yet (or
 * lags behind). Used as a last-chance fallback for context window, pricing, and
 * vision so a brand-new API (e.g. Meta Muse Spark) doesn't silently inherit the
 * session's 128k / $0 defaults.
 *
 * Config `contextWindow` / `pricing` pins always win over these; models.dev
 * exact hits also win. Keep entries small and sourced from the vendor docs.
 */
export interface KnownModelDefaults {
  contextWindow: number;
  /** USD per 1M tokens (same shape as CatalogService pricing). */
  pricing: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  vision?: boolean;
  /** Max output tokens when the vendor publishes one. */
  maxOutput?: number;
}

/**
 * Keyed by full `provider/model` string (case-sensitive id as sent to the API).
 * Sources:
 * - meta/muse-spark-1.1: https://dev.meta.ai/docs/getting-started/models + pricing
 */
export const KNOWN_MODEL_DEFAULTS: Record<string, KnownModelDefaults> = {
  "meta/muse-spark-1.1": {
    contextWindow: 1_048_576,
    maxOutput: 131_072,
    pricing: {
      input: 1.25,
      output: 4.25,
      cacheRead: 0.15,
    },
    vision: true,
  },
};

/** Lookup published defaults for a model string, if any. */
export function knownModelDefaults(modelString: string): KnownModelDefaults | undefined {
  return KNOWN_MODEL_DEFAULTS[modelString];
}

/** Partial ModelInfo suitable for catalog enrichment of a known model. */
export function knownModelInfo(modelString: string): Partial<ModelInfo> | undefined {
  const known = knownModelDefaults(modelString);
  if (!known) return undefined;
  const slash = modelString.indexOf("/");
  const providerId = slash < 0 ? "" : modelString.slice(0, slash);
  const id = slash < 0 ? modelString : modelString.slice(slash + 1);
  return {
    id,
    providerId,
    contextWindow: known.contextWindow,
    maxOutput: known.maxOutput,
    cost: {
      input: known.pricing.input,
      output: known.pricing.output,
      cacheRead: known.pricing.cacheRead,
      cacheWrite: known.pricing.cacheWrite,
    },
    capabilities: {
      toolCall: true,
      reasoning: true,
      vision: known.vision,
    },
  };
}
