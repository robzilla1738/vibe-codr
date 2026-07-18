import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "@vibe/config";
import { ModelResolutionError, ProviderAuthError } from "@vibe/shared";
import type { EmbeddingModel, LanguageModel } from "ai";
import { readTokenFile, tokenFileVersion } from "./auth-file.ts";
import { builtinProviders, configDefinedProvider, configProviderEnvironmentName } from "./defs.ts";
import { parseModelString } from "./resolve.ts";
import type { ModelInfo, ProviderCreateOptions, ProviderDef } from "./types.ts";

/**
 * Holds provider definitions and turns a model string + config into a live
 * AI-SDK `LanguageModel`. Providers can be added by plugins via `register`.
 */
export class ProviderRegistry {
  #providers = new Map<string, ProviderDef>();
  #modelCache = new Map<string, Promise<LanguageModel>>();
  #providerGeneration = 0;

  constructor(defs: ProviderDef[] = builtinProviders()) {
    for (const def of defs) this.register(def);
  }

  register(def: ProviderDef): void {
    this.#providers.set(def.id, def);
    this.#providerGeneration += 1;
    this.#modelCache.clear();
  }

  /** Remove a previously-registered provider (plugin load rollback — BUG-099). */
  unregister(id: string): void {
    this.#providers.delete(id);
    this.#providerGeneration += 1;
    this.#modelCache.clear();
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  get(id: string): ProviderDef | undefined {
    return this.#providers.get(id);
  }

  list(config?: Config): ProviderDef[] {
    const definitions = new Map(this.#providers);
    if (config) {
      for (const [id, provider] of Object.entries(config.providers)) {
        if (!definitions.has(id) && provider.baseURL) {
          definitions.set(id, configDefinedProvider(id, provider.transport));
        }
      }
    }
    return [...definitions.values()];
  }

  #definition(id: string, config: Config): ProviderDef | undefined {
    return (
      this.#providers.get(id) ??
      (config.providers[id]?.baseURL
        ? configDefinedProvider(id, config.providers[id]?.transport)
        : process.env[configProviderEnvironmentName(id, "BASE_URL")]
          ? configDefinedProvider(id, cloudTransport(id))
          : undefined)
    );
  }

  /**
   * Resolve credentials for a provider: env vars take precedence over config.
   * Returns `undefined` apiKey for keyless providers (e.g. LM Studio).
   */
  resolveAuth(id: string, config: Config): ProviderCreateOptions {
    const def = this.#definition(id, config);
    if (!def) throw new ModelResolutionError(id, "unknown provider");
    const apiKey = this.#resolveKey(def, config.providers[id]);
    const baseURL = config.providers[id]?.baseURL;
    let headers = config.providers[id]?.headers ?? cloudProviderHeaders(id);
    if ((id === "codex" || id === "openai-codex") && !hasHeader(headers, "chatgpt-account-id")) {
      const accountId =
        process.env.CODEX_ACCOUNT_ID ?? this.#resolveCodexAccountId(def, config.providers[id]);
      if (accountId) headers = { ...headers, "ChatGPT-Account-Id": accountId };
    }
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
    if (tokenFile) {
      // A custom token file must not inherit the built-in file's JSON path.
      // Without this, pointing Codex at ~/.codex/auth.json still looked for
      // providers.openai-codex.access from Vibe's own store.
      const tokenPath = cfg?.tokenFile ? cfg.tokenPath : (cfg?.tokenPath ?? def.auth.tokenPath);
      const token = readTokenFile(tokenFile, tokenPath);
      if (token) return token;
    }
    if (!cfg?.tokenFile) {
      for (const fallback of def.auth.fallbackTokenFiles ?? []) {
        const token = readTokenFile(fallback.path, fallback.tokenPath);
        if (token) return token;
      }
    }
    return undefined;
  }

  #resolveCodexAccountId(
    def: ProviderDef,
    cfg: Config["providers"][string] | undefined,
  ): string | undefined {
    const candidates = cfg?.tokenFile
      ? [cfg.tokenFile]
      : [
          def.auth.tokenFile,
          ...(def.auth.fallbackTokenFiles ?? []).map((item) => item.path),
        ].filter((path): path is string => Boolean(path));
    for (const path of candidates) {
      for (const field of [
        "providers.openai-codex.accountId",
        "tokens.account_id",
        "account_id",
        "chatgpt_account_id",
      ]) {
        const accountId = readTokenFile(path, field);
        if (accountId) return accountId;
      }
    }
    return undefined;
  }

  /** Whether a provider has usable credentials (or is keyless). */
  isConfigured(id: string, config: Config): boolean {
    const def = this.#definition(id, config);
    if (!def) return false;
    if (def.auth.externalAuth && !this.#hasExternalAuth(def.auth.externalAuth)) return false;
    if (def.auth.keyless) {
      if (!def.auth.requiresBaseURL) return true;
      return this.#hasRequiredEndpoint(def, config.providers[id]);
    }
    // A non-keyless provider with requiresBaseURL needs BOTH a key AND a base
    // URL to be truly usable (e.g. Snowflake Cortex, Cloudflare Workers AI —
    // the base URL carries an account ID so there's no sensible default).
    const hasKey = Boolean(this.#resolveKey(def, config.providers[id]));
    if (!hasKey) return false;
    if (!def.auth.requiresBaseURL) return true;
    return this.#hasRequiredEndpoint(def, config.providers[id]);
  }

  #hasExternalAuth(kind: "aws" | "google-adc"): boolean {
    if (kind === "aws") {
      return Boolean(
        process.env.AWS_BEARER_TOKEN_BEDROCK ||
          process.env.AWS_PROFILE ||
          process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
          process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
          process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
          (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
          existsSync(join(homedir(), ".aws", "credentials")),
      );
    }
    return Boolean(
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        existsSync(join(homedir(), ".config", "gcloud", "application_default_credentials.json")),
    );
  }

  #hasRequiredEndpoint(def: ProviderDef, cfg: Config["providers"][string] | undefined): boolean {
    if (cfg?.baseURL) return true;
    if (def.auth.baseURLEnv && process.env[def.auth.baseURLEnv]) return true;
    return (
      def.auth.endpointEnvGroups?.some((group) => group.every((name) => process.env[name])) ?? false
    );
  }

  /** Resolve a full model string to a live `LanguageModel`. */
  async resolveModel(modelString: string, config: Config): Promise<LanguageModel> {
    const { providerId, modelId } = parseModelString(modelString);
    const def = this.#definition(providerId, config);
    if (!def) {
      throw new ModelResolutionError(modelString, `unknown provider "${providerId}"`);
    }
    const opts = this.resolveAuth(providerId, config);
    const cfg = config.providers[providerId];
    const tokenFiles = [
      cfg?.tokenFile ?? def.auth.tokenFile,
      ...(!cfg?.tokenFile ? (def.auth.fallbackTokenFiles ?? []).map((item) => item.path) : []),
    ].filter((path): path is string => Boolean(path));
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          generation: this.#providerGeneration,
          providerId,
          modelId,
          apiKey: opts.apiKey,
          baseURL: opts.baseURL,
          headers: Object.entries(opts.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          tokenFiles: tokenFiles.map((path) => [path, tokenFileVersion(path)]),
        }),
      )
      .digest("base64url");
    let pending = this.#modelCache.get(fingerprint);
    if (!pending) {
      pending = Promise.resolve(def.create(modelId, opts));
      this.#modelCache.set(fingerprint, pending);
      while (this.#modelCache.size > 32) {
        const oldest = this.#modelCache.keys().next().value;
        if (typeof oldest !== "string") break;
        this.#modelCache.delete(oldest);
      }
      void pending.catch(() => {
        if (this.#modelCache.get(fingerprint) === pending) this.#modelCache.delete(fingerprint);
      });
    } else {
      this.#modelCache.delete(fingerprint);
      this.#modelCache.set(fingerprint, pending);
    }
    return pending;
  }

  /** Resolve a full model string to a live text-embedding model (for semantic
   * memory). Throws if the provider is unknown, unconfigured, or has no
   * embedding support — the caller catches and degrades to lexical recall. */
  async embeddingModel(modelString: string, config: Config): Promise<EmbeddingModel> {
    const { providerId, modelId } = parseModelString(modelString);
    const def = this.#definition(providerId, config);
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
    const configured = this.list(config).flatMap((d) => {
      try {
        return [{ def: d, auth: this.resolveAuth(d.id, config) }];
      } catch {
        return [];
      }
    });
    const results = await Promise.all(
      configured.map(async ({ def, auth }) => {
        const live = await def.listModels(auth).catch(() => []);
        const explicit = config.providers[def.id]?.models ?? [];
        const seen = new Set(live.map((model) => model.id));
        return [
          ...live,
          ...explicit.filter((id) => !seen.has(id)).map((id) => ({ id, providerId: def.id })),
        ];
      }),
    );
    return results.flat();
  }
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === name.toLowerCase());
}

function cloudTransport(id: string): "openai-compatible" | "openai-responses" {
  return process.env[configProviderEnvironmentName(id, "TRANSPORT")] === "openai-responses"
    ? "openai-responses"
    : "openai-compatible";
}

function cloudProviderHeaders(id: string): Record<string, string> | undefined {
  const raw = process.env[configProviderEnvironmentName(id, "HEADERS_JSON")];
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.values(value).some((item) => typeof item !== "string")
    )
      throw new Error();
    return value as Record<string, string>;
  } catch {
    throw new ModelResolutionError(id, "invalid cloud provider headers");
  }
}
