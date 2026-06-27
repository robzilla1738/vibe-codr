import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, type Logger } from "@vibe/shared";
import type { ModelInfo } from "./types.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface CacheFile {
  fetchedAt: number;
  data: unknown;
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

  constructor(log: Logger = createLogger("catalog")) {
    this.#log = log;
    this.#cachePath = join(
      homedir(),
      ".cache",
      "vibe-codr",
      "models.dev.json",
    );
  }

  /** Enrich live models with models.dev metadata (best-effort). */
  async enrich(live: ModelInfo[]): Promise<ModelInfo[]> {
    const meta = await this.#loadMetadata();
    return live.map((m) => {
      const extra = meta.get(`${m.providerId}/${m.id}`);
      return extra ? { ...extra, ...m } : m;
    });
  }

  async #loadMetadata(): Promise<Map<string, Partial<ModelInfo>>> {
    if (this.#metadata) return this.#metadata;
    const raw = await this.#fetchCatalog();
    this.#metadata = raw ? parseModelsDev(raw) : new Map();
    return this.#metadata;
  }

  async #fetchCatalog(): Promise<unknown | null> {
    const cached = await this.#readCache();
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }
    try {
      const res = await fetch(MODELS_DEV_URL);
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
        },
      });
    }
  }
  return out;
}
