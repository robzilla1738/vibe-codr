import type { ProviderConfig } from "@vibe/config";
import type { EmbeddingModel, LanguageModel } from "ai";

/**
 * One long-context pricing tier from models.dev `cost.tiers`: once a request's
 * prompt exceeds `threshold` tokens, the whole request bills at these rates.
 * Providers (Google, OpenAI, xAI, …) step the ENTIRE request — input, output,
 * cache read/write — up to the tier's price once the prompt crosses the line; a
 * rate the tier omits inherits the base (untiered) rate.
 */
export interface PricingTier {
  /** Prompt-token count above which this tier applies (models.dev `tier.size`,
   * which varies by model: 200k for Gemini, 272k for GPT-5.x, 256k for Qwen). */
  threshold: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Capability + cost metadata, enriched from models.dev. */
export interface ModelInfo {
  /** Provider-local model id, e.g. "claude-opus-4-8". */
  id: string;
  providerId: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    /** Long-context pricing tiers (ascending by threshold), when the model
     * prices a big prompt higher; absent for flat-rate models. */
    tiers?: PricingTier[];
  };
  capabilities?: {
    toolCall?: boolean;
    reasoning?: boolean;
    structuredOutput?: boolean;
    /** Accepts image input (vision). */
    vision?: boolean;
  };
}

/** Resolved credentials/base URL passed to a provider factory. */
export interface ProviderCreateOptions {
  apiKey?: string;
  baseURL?: string;
  /** Extra HTTP headers (e.g. a gateway account id for subscription auth). */
  headers?: Record<string, string>;
}

/** How a provider authenticates (env var names + optional base-URL env). */
export interface ProviderAuth {
  env: string[];
  baseURLEnv?: string;
  /** True when keyless auth is allowed but an endpoint URL is still required. */
  requiresBaseURL?: boolean;
  /** Environment-variable groups that can construct the endpoint without an
   * explicit base URL. A provider is ready when every name in any group is set. */
  endpointEnvGroups?: readonly (readonly string[])[];
  /** External credential chain whose readiness is not represented by apiKey. */
  externalAuth?: "aws" | "google-adc";
  /** True for providers that need no key (e.g. LM Studio on localhost). */
  keyless?: boolean;
  /** Default credential file to read a token from (e.g. Codex's auth.json). */
  tokenFile?: string;
  /** Default dot-path into a JSON token file. */
  tokenPath?: string;
  /** Additional credential files tried after tokenFile (for CLI interoperability). */
  fallbackTokenFiles?: readonly { path: string; tokenPath?: string }[];
}

/** A registered provider: how to create models and list what's available. */
export interface ProviderDef {
  id: string;
  auth: ProviderAuth;
  /** Build an AI-SDK language model for `modelId`. */
  create(modelId: string, opts: ProviderCreateOptions): LanguageModel | Promise<LanguageModel>;
  /** Build an AI-SDK text-embedding model for `modelId`, when the provider
   * supports embeddings (OpenAI + most OpenAI-compatible). Optional; absent or
   * throwing means "no embeddings here" and the caller degrades to lexical. */
  createEmbedding?(
    modelId: string,
    opts: ProviderCreateOptions,
  ): EmbeddingModel<string> | Promise<EmbeddingModel<string>>;
  /** Live availability via the provider's `/v1/models` (or SDK). */
  listModels(opts: ProviderCreateOptions): Promise<ModelInfo[]>;
}

/** Parsed `<provider>/<model-id>` reference. */
export interface ModelRef {
  providerId: string;
  modelId: string;
}

export type ResolvedProviderConfig = ProviderConfig | undefined;
