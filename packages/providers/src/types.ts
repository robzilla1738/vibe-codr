import type { LanguageModel } from "ai";
import type { ProviderConfig } from "@vibe/config";

/** Capability + cost metadata, enriched from models.dev. */
export interface ModelInfo {
  /** Provider-local model id, e.g. "claude-opus-4-8". */
  id: string;
  providerId: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
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
  /** True for providers that need no key (e.g. LM Studio on localhost). */
  keyless?: boolean;
  /** Default credential file to read a token from (e.g. Codex's auth.json). */
  tokenFile?: string;
  /** Default dot-path into a JSON token file. */
  tokenPath?: string;
}

/** A registered provider: how to create models and list what's available. */
export interface ProviderDef {
  id: string;
  auth: ProviderAuth;
  /** Build an AI-SDK language model for `modelId`. */
  create(
    modelId: string,
    opts: ProviderCreateOptions,
  ): LanguageModel | Promise<LanguageModel>;
  /** Live availability via the provider's `/v1/models` (or SDK). */
  listModels(opts: ProviderCreateOptions): Promise<ModelInfo[]>;
}

/** Parsed `<provider>/<model-id>` reference. */
export interface ModelRef {
  providerId: string;
  modelId: string;
}

export type ResolvedProviderConfig = ProviderConfig | undefined;
