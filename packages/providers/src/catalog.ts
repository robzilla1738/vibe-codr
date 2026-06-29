import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, type Logger } from "@vibe/shared";
import type { ModelInfo } from "./types.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 8000;

interface CacheFile {
  fetchedAt: number;
  data: unknown;
}

/** Price (USD per 1M tokens), with `estimated` set for a base-model fallback. */
export interface PricingResult {
  input?: number;
  output?: number;
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
    this.#cachePath = join(
      homedir(),
      ".cache",
      "vibe-codr",
      "models.dev.json",
    );
  }

  /**
   * Best-effort context window (tokens) for a `provider/model` string.
   * NON-BLOCKING: if the catalog isn't loaded yet, this kicks off a background
   * load and returns `undefined` so the caller (per-turn compaction) never
   * stalls on the network. Subsequent turns get the real value once it lands.
   */
  async contextWindow(modelString: string): Promise<number | undefined> {
    if (this.#metadata) return this.#metadata.get(modelString)?.contextWindow;
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
    return resolveCatalogPrice(this.#metadata, modelString);
  }

  /**
   * Whether a model accepts image input. NON-BLOCKING: returns undefined until
   * the catalog has loaded (and for models it doesn't know about).
   */
  async supportsImages(modelString: string): Promise<boolean | undefined> {
    if (this.#metadata) return this.#metadata.get(modelString)?.capabilities?.vision;
    void this.#load();
    return undefined;
  }

  /** Enrich live models with models.dev metadata (best-effort, awaits load). */
  async enrich(live: ModelInfo[]): Promise<ModelInfo[]> {
    const meta = await this.#load();
    return live.map((m) => {
      const extra = meta.get(`${m.providerId}/${m.id}`);
      return extra ? { ...extra, ...m } : m;
    });
  }

  /** Load (and memoize) the catalog metadata; a single in-flight fetch is shared. */
  #load(): Promise<Map<string, Partial<ModelInfo>>> {
    if (this.#metadata) return Promise.resolve(this.#metadata);
    if (!this.#loadPromise) {
      this.#loadPromise = this.#fetchCatalog().then((raw) => {
        this.#metadata = raw ? parseModelsDev(raw) : new Map();
        return this.#metadata;
      });
    }
    return this.#loadPromise;
  }

  async #fetchCatalog(): Promise<unknown | null> {
    const cached = await this.#readCache();
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
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
        cost: { input: m?.cost?.input, output: m?.cost?.output },
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
