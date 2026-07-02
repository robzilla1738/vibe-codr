import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, type Logger } from "@vibe/shared";
import type { ModelInfo } from "./types.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 8000;

/**
 * Map a vibe provider id to its models.dev catalog slug where they differ, so
 * enrichment lands for every provider. Most ids match models.dev 1:1; these are
 * the verified exceptions. Providers with no catalog presence (lmstudio, custom,
 * local ollama tags) simply don't enrich — they fall back to the base-model price
 * match and the session's default context window.
 */
export const PROVIDER_SLUG_ALIASES: Record<string, string> = {
  together: "togetherai",
  fireworks: "fireworks-ai",
  codex: "openai", // Codex serves OpenAI models
};

/** Rewrite the provider prefix of a `provider/model` key to its catalog slug. */
export function aliasModelKey(modelString: string): string {
  const slash = modelString.indexOf("/");
  if (slash < 0) return modelString;
  const alias = PROVIDER_SLUG_ALIASES[modelString.slice(0, slash)];
  return alias ? `${alias}${modelString.slice(slash)}` : modelString;
}

interface CacheFile {
  fetchedAt: number;
  data: unknown;
}

/** Price (USD per 1M tokens), with `estimated` set for a base-model fallback. */
export interface PricingResult {
  input?: number;
  output?: number;
  /** Per-1M price of a cached-input (prompt-cache read) token, when known. */
  cacheRead?: number;
  /** Per-1M price of writing the prompt cache, when known. */
  cacheWrite?: number;
  estimated?: boolean;
}

function hasPrice(c: { input?: number; output?: number } | undefined): c is {
  input?: number;
  output?: number;
} {
  return !!c && (c.input !== undefined || c.output !== undefined);
}

/**
 * The bare model id/family for fuzzy matching: drop the provider prefix and any
 * `:tag` suffix, lowercased. `ollama/glm-5.2` and `zhipuai/glm-5.2` both → `glm-5.2`;
 * `ollama/gpt-oss:120b` → `gpt-oss`.
 */
function baseModelId(modelString: string): string {
  const afterProvider = modelString.includes("/")
    ? modelString.slice(modelString.indexOf("/") + 1)
    : modelString;
  return afterProvider.split(":")[0]!.toLowerCase();
}

/**
 * Resolve a model's price from a loaded catalog map: an exact `provider/model`
 * hit (real), else a base-model match across providers flagged `estimated`.
 */
export function resolveCatalogPrice(
  metadata: Map<string, Partial<ModelInfo>>,
  modelString: string,
): PricingResult | undefined {
  const exact = metadata.get(modelString)?.cost;
  if (hasPrice(exact)) return exact;
  const bare = baseModelId(modelString);
  if (bare) {
    for (const [key, meta] of metadata) {
      if (hasPrice(meta.cost) && baseModelId(key) === bare) {
        return { ...meta.cost, estimated: true };
      }
    }
  }
  return exact;
}

/**
 * Fetches the models.dev catalog (capabilities, context window, pricing) and
 * uses it to ENRICH live `/v1/models` results. Live ids are the source of
 * truth for availability; models.dev supplies metadata. Cached to disk with a
 * 24h TTL and degraded gracefully when offline.
 */
export class CatalogService {
  #log: Logger;
  #cachePath: string;
  #metadata: Map<string, Partial<ModelInfo>> | null = null;
  #loadPromise: Promise<Map<string, Partial<ModelInfo>>> | null = null;

  constructor(log: Logger = createLogger("catalog")) {
    this.#log = log;
    // Honor $XDG_CACHE_HOME (its default is ~/.cache), read at construction. This
    // also isolates the cache in tests — Bun's os.homedir() caches at startup and
    // ignores a runtime $HOME, but XDG_CACHE_HOME is read live, so the test
    // preload can keep the suite off the developer's real catalog cache.
    const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    this.#cachePath = join(base, "vibe-codr", "models.dev.json");
  }

  /**
   * Best-effort context window (tokens) for a `provider/model` string.
   * NON-BLOCKING: if the catalog isn't loaded yet, this kicks off a background
   * load and returns `undefined` so the caller (per-turn compaction) never
   * stalls on the network. Subsequent turns get the real value once it lands.
   */
  async contextWindow(modelString: string): Promise<number | undefined> {
    if (this.#metadata) return this.#metadata.get(aliasModelKey(modelString))?.contextWindow;
    void this.#load(); // warm the cache for next time, but don't wait on it
    return undefined;
  }

  /**
   * Best-effort price (USD per 1M tokens) for a `provider/model` string.
   * NON-BLOCKING, like {@link contextWindow}: returns undefined until the
   * catalog has loaded in the background.
   *
   * Falls back to a base-model match when the exact `provider/model` key is
   * missing: a custom or cloud tag (e.g. `ollama/glm-5.2`) inherits a known
   * model's price as an ESTIMATE (`estimated: true`), so cost is still shown for
   * models the catalog doesn't list verbatim.
   */
  async pricing(modelString: string): Promise<PricingResult | undefined> {
    if (!this.#metadata) {
      void this.#load();
      return undefined;
    }
    return resolveCatalogPrice(this.#metadata, aliasModelKey(modelString));
  }

  /**
   * Whether a model accepts image input. NON-BLOCKING: returns undefined until
   * the catalog has loaded (and for models it doesn't know about).
   */
  async supportsImages(modelString: string): Promise<boolean | undefined> {
    if (this.#metadata) return this.#metadata.get(aliasModelKey(modelString))?.capabilities?.vision;
    void this.#load();
    return undefined;
  }

  /** Enrich live models with models.dev metadata (best-effort, awaits load). */
  async enrich(live: ModelInfo[]): Promise<ModelInfo[]> {
    const meta = await this.#load();
    return live.map((m) => {
      const extra = meta.get(aliasModelKey(`${m.providerId}/${m.id}`));
      return extra ? { ...extra, ...m } : m;
    });
  }

  /**
   * Force a fresh fetch of the models.dev catalog, bypassing the 24h cache, and
   * return how many models are now known. Backs `/models refresh` so a user can
   * pull a just-released model's metadata without waiting for the cache to expire.
   */
  async refresh(): Promise<number> {
    const raw = await this.#fetchCatalog(true);
    // A FAILED forced refresh (raw null) must not wipe good metadata to an empty
    // map — keep what we had and report its size, so `/models refresh` while
    // offline degrades to "unchanged" instead of "all models forgotten".
    if (raw) {
      this.#metadata = parseModelsDev(raw);
      this.#loadPromise = Promise.resolve(this.#metadata);
    }
    return this.#metadata?.size ?? 0;
  }

  /** Load (and memoize) the catalog metadata; a single in-flight fetch is shared. */
  #load(): Promise<Map<string, Partial<ModelInfo>>> {
    if (this.#metadata) return Promise.resolve(this.#metadata);
    if (!this.#loadPromise) {
      this.#loadPromise = this.#fetchCatalog().then((raw) => {
        if (raw) {
          this.#metadata = parseModelsDev(raw);
          return this.#metadata;
        }
        // Fetch failed AND no cache: do NOT poison `#metadata` with an empty map —
        // that's truthy, so every later contextWindow()/pricing() would take the
        // fast path and never retry the network, pinning all models to the 128k
        // default + $0 pricing for the whole process. Clear the in-flight promise
        // so the NEXT lookup retries; return an empty map for THIS call only.
        this.#loadPromise = null;
        return new Map<string, Partial<ModelInfo>>();
      });
    }
    return this.#loadPromise;
  }

  async #fetchCatalog(force = false): Promise<unknown | null> {
    const cached = await this.#readCache();
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }
    try {
      const res = await fetch(MODELS_DEV_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      await this.#writeCache({ fetchedAt: Date.now(), data });
      return data;
    } catch (err) {
      this.#log.warn(`models.dev fetch failed: ${(err as Error).message}`);
      return cached?.data ?? null; // stale-but-usable, or nothing
    }
  }

  async #readCache(): Promise<CacheFile | null> {
    try {
      const file = Bun.file(this.#cachePath);
      if (!(await file.exists())) return null;
      return (await file.json()) as CacheFile;
    } catch {
      return null;
    }
  }

  async #writeCache(file: CacheFile): Promise<void> {
    try {
      await Bun.write(this.#cachePath, JSON.stringify(file));
    } catch (err) {
      this.#log.debug(`cache write failed: ${(err as Error).message}`);
    }
  }
}

/** Flatten the models.dev `api.json` into `providerId/modelId -> ModelInfo`. */
export function parseModelsDev(raw: unknown): Map<string, Partial<ModelInfo>> {
  const out = new Map<string, Partial<ModelInfo>>();
  if (typeof raw !== "object" || raw === null) return out;
  for (const [providerId, providerRaw] of Object.entries(
    raw as Record<string, any>,
  )) {
    const models = providerRaw?.models;
    if (typeof models !== "object" || models === null) continue;
    for (const [modelId, m] of Object.entries(models as Record<string, any>)) {
      out.set(`${providerId}/${modelId}`, {
        id: modelId,
        providerId,
        name: m?.name,
        contextWindow: m?.limit?.context,
        maxOutput: m?.limit?.output,
        cost: {
          input: m?.cost?.input,
          output: m?.cost?.output,
          cacheRead: m?.cost?.cache_read,
          cacheWrite: m?.cost?.cache_write,
        },
        capabilities: {
          toolCall: m?.tool_call,
          reasoning: m?.reasoning,
          structuredOutput: m?.structured_output,
          vision: Array.isArray(m?.modalities?.input)
            ? m.modalities.input.includes("image")
            : undefined,
        },
      });
    }
  }
  return out;
}
