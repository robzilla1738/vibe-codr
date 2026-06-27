import type { LanguageModel } from "ai";
import { ModelResolutionError, ProviderAuthError } from "@vibe/shared";
import type { Config } from "@vibe/config";
import type { ProviderDef, ProviderCreateOptions, ModelInfo } from "./types.ts";
import { parseModelString } from "./resolve.ts";
import { builtinProviders } from "./defs.ts";

/**
 * Holds provider definitions and turns a model string + config into a live
 * AI-SDK `LanguageModel`. Providers can be added by plugins via `register`.
 */
export class ProviderRegistry {
  #providers = new Map<string, ProviderDef>();

  constructor(defs: ProviderDef[] = builtinProviders()) {
    for (const def of defs) this.register(def);
  }

  register(def: ProviderDef): void {
    this.#providers.set(def.id, def);
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  get(id: string): ProviderDef | undefined {
    return this.#providers.get(id);
  }

  list(): ProviderDef[] {
    return [...this.#providers.values()];
  }

  /**
   * Resolve credentials for a provider: env vars take precedence over config.
   * Returns `undefined` apiKey for keyless providers (e.g. LM Studio).
   */
  resolveAuth(id: string, config: Config): ProviderCreateOptions {
    const def = this.#providers.get(id);
    if (!def) throw new ModelResolutionError(id, "unknown provider");
    const apiKey =
      def.auth.env.map((e) => process.env[e]).find(Boolean) ??
      config.providers[id]?.apiKey;
    const baseURL = config.providers[id]?.baseURL;
    if (!apiKey && !def.auth.keyless) {
      throw new ProviderAuthError(id, def.auth.env);
    }
    return apiKey === undefined ? { baseURL } : { apiKey, baseURL };
  }

  /** Whether a provider has usable credentials (or is keyless). */
  isConfigured(id: string, config: Config): boolean {
    const def = this.#providers.get(id);
    if (!def) return false;
    if (def.auth.keyless) return true;
    return (
      def.auth.env.some((e) => Boolean(process.env[e])) ||
      Boolean(config.providers[id]?.apiKey)
    );
  }

  /** Resolve a full model string to a live `LanguageModel`. */
  async resolveModel(
    modelString: string,
    config: Config,
  ): Promise<LanguageModel> {
    const { providerId, modelId } = parseModelString(modelString);
    const def = this.#providers.get(providerId);
    if (!def) {
      throw new ModelResolutionError(modelString, `unknown provider "${providerId}"`);
    }
    const opts = this.resolveAuth(providerId, config);
    return def.create(modelId, opts);
  }

  /** List live models for every configured provider, enriched elsewhere. */
  async listConfiguredModels(config: Config): Promise<ModelInfo[]> {
    const configured = this.list().filter((d) => this.isConfigured(d.id, config));
    const results = await Promise.all(
      configured.map((d) =>
        d.listModels(this.resolveAuth(d.id, config)).catch(() => []),
      ),
    );
    return results.flat();
  }
}
