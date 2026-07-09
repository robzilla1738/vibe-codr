import type { LanguageModel, EmbeddingModel } from "ai";
import { ModelResolutionError, ProviderAuthError } from "@vibe/shared";
import type { Config } from "@vibe/config";
import type { ProviderDef, ProviderCreateOptions, ModelInfo } from "./types.ts";
import { parseModelString } from "./resolve.ts";
import { builtinProviders } from "./defs.ts";
import { readTokenFile } from "./auth-file.ts";

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

  /** Remove a previously-registered provider (plugin load rollback — BUG-099). */
  unregister(id: string): void {
    this.#providers.delete(id);
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
    const apiKey = this.#resolveKey(def, config.providers[id]);
    const baseURL = config.providers[id]?.baseURL;
    const headers = config.providers[id]?.headers;
    if (!apiKey && !def.auth.keyless) {
      throw new ProviderAuthError(id, def.auth.env);
    }
    const opts: ProviderCreateOptions = {};
    if (apiKey !== undefined) opts.apiKey = apiKey;
    if (baseURL !== undefined) opts.baseURL = baseURL;
    if (headers !== undefined) opts.headers = headers;
    return opts;
  }

  /**
   * Resolve a credential: env vars win, then config `apiKey`, then a token file
   * (config override or the provider's default, e.g. Codex's `~/.codex/auth.json`).
   */
  #resolveKey(def: ProviderDef, cfg: Config["providers"][string] | undefined): string | undefined {
    const fromEnv = def.auth.env.map((e) => process.env[e]).find(Boolean);
    if (fromEnv) return fromEnv;
    if (cfg?.apiKey) return cfg.apiKey;
    const tokenFile = cfg?.tokenFile ?? def.auth.tokenFile;
    if (tokenFile) return readTokenFile(tokenFile, cfg?.tokenPath ?? def.auth.tokenPath);
    return undefined;
  }

  /** Whether a provider has usable credentials (or is keyless). */
  isConfigured(id: string, config: Config): boolean {
    const def = this.#providers.get(id);
    if (!def) return false;
    if (def.auth.keyless) {
      if (!def.auth.requiresBaseURL) return true;
      return Boolean(
        config.providers[id]?.baseURL ||
          (def.auth.baseURLEnv ? process.env[def.auth.baseURLEnv] : undefined),
      );
    }
    return Boolean(this.#resolveKey(def, config.providers[id]));
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

  /** Resolve a full model string to a live text-embedding model (for semantic
   * memory). Throws if the provider is unknown, unconfigured, or has no
   * embedding support — the caller catches and degrades to lexical recall. */
  async embeddingModel(
    modelString: string,
    config: Config,
  ): Promise<EmbeddingModel<string>> {
    const { providerId, modelId } = parseModelString(modelString);
    const def = this.#providers.get(providerId);
    if (!def) {
      throw new ModelResolutionError(modelString, `unknown provider "${providerId}"`);
    }
    if (!def.createEmbedding) {
      throw new ModelResolutionError(
        modelString,
        `provider "${providerId}" has no embedding support`,
      );
    }
    const opts = this.resolveAuth(providerId, config);
    return def.createEmbedding(modelId, opts);
  }

  /** List live models for every configured provider, enriched elsewhere. */
  async listConfiguredModels(config: Config): Promise<ModelInfo[]> {
    // Resolve each provider's credentials ONCE — filtering with isConfigured
    // and then calling resolveAuth would read a token file (a sync disk read,
    // e.g. codex's ~/.codex/auth.json) twice per provider. resolveAuth throws
    // exactly when isConfigured is false, so the catch is the filter.
    const configured = this.list().flatMap((d) => {
      try {
        return [{ def: d, auth: this.resolveAuth(d.id, config) }];
      } catch {
        return [];
      }
    });
    const results = await Promise.all(
      configured.map(({ def, auth }) => def.listModels(auth).catch(() => [])),
    );
    return results.flat();
  }
}
