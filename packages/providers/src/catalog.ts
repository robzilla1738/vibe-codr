import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, type Logger } from "@vibe/shared";
import type { ModelInfo, PricingTier } from "./types.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 8000;

/**
 * Map a vibe provider id to its models.dev catalog slug where they differ, so
 * enrichment lands for every provider. Most ids match models.dev 1:1; these are
 * the verified exceptions. Models with no catalog presence (custom endpoints,
 * unlisted local tags) simply don't enrich — they fall back to the base-model
 * price match and the session's default context window.
 */
export const PROVIDER_SLUG_ALIASES: Record<string, string> = {
  together: "togetherai",
  fireworks: "fireworks-ai",
  codex: "openai", // Codex serves OpenAI models
  moonshot: "moonshotai",
  // Hosted ollama.com ids (e.g. `glm-5.2`, `gpt-oss:120b`) are cataloged under
  // `ollama-cloud`; purely local tags miss and fall back as before.
  ollama: "ollama-cloud",
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
  /** Long-context pricing tiers, when the model prices a big prompt higher. Rides
   * on the price object so it flows through to the cost computation unchanged. */
  tiers?: PricingTier[];
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
 *
 * Local providers (`ollama` without `OLLAMA_API_KEY`, `lmstudio`) mirror the
 * window-resolution guard: no cloud-slug alias and no fuzzy fallback — a free
 * local tag must not inherit a cloud namesake's non-estimated rates (BUG-102).
 */
export function resolveCatalogPrice(
  metadata: Map<string, Partial<ModelInfo>>,
  modelString: string,
): PricingResult | undefined {
  const provider = providerOf(modelString);
  const cloudPlausible = provider !== "ollama" || Boolean(process.env.OLLAMA_API_KEY);
  const key = cloudPlausible ? aliasModelKey(modelString) : modelString;
  const exact = metadata.get(key)?.cost;
  if (hasPrice(exact)) return exact;
  // Locally-probed providers: no fuzzy price (same hazard class as windows —
  // wrong non-estimated rates hard-stop free local sessions on budget).
  if (LOCALLY_PROBED_PROVIDERS.has(provider)) return undefined;
  const bare = baseModelId(modelString);
  if (bare) {
    for (const [k, meta] of metadata) {
      if (hasPrice(meta.cost) && baseModelId(k) === bare) {
        return { ...meta.cost, estimated: true };
      }
    }
  }
  return exact;
}

/** Providers that serve models LOCALLY and are live-probed for the SERVED
 * context window. A fuzzy catalog window for these is exactly the over-report
 * hazard: a small local tag inheriting a cloud namesake's huge window means
 * compaction never fires and every long turn 400s — so catalog window
 * fallbacks stay conservative (undefined) for them, and the probe remains
 * their source of truth. */
const LOCALLY_PROBED_PROVIDERS = new Set(["ollama", "lmstudio"]);

function providerOf(modelString: string): string {
  const slash = modelString.indexOf("/");
  return slash < 0 ? "" : modelString.slice(0, slash);
}

/**
 * Resolve a model's context window from a loaded catalog map. An exact hit
 * wins; a miss falls back to a base-model match across providers — the same
 * fallback `resolveCatalogPrice` has, because an ESTIMATED window for a known
 * base model beats the session's blanket 128k default in both directions
 * (a fine-tune/variant id inherits its family's real window). Shared guards
 * with price resolution:
 *   - locally-probed providers get NO fuzzy fallback (see
 *     {@link LOCALLY_PROBED_PROVIDERS} — a wrong window truncates turns; a
 *     wrong non-estimated price hard-stops free local sessions);
 *   - the `ollama`→`ollama-cloud` slug alias is honored only when cloud is
 *     plausibly in play (`OLLAMA_API_KEY`, the probe's own routing signal) —
 *     otherwise a purely local tag would read its cloud namesake's metadata.
 */
export function resolveCatalogWindow(
  metadata: Map<string, Partial<ModelInfo>>,
  modelString: string,
): number | undefined {
  const provider = providerOf(modelString);
  const cloudPlausible = provider !== "ollama" || Boolean(process.env.OLLAMA_API_KEY);
  const key = cloudPlausible ? aliasModelKey(modelString) : modelString;
  const exact = metadata.get(key)?.contextWindow;
  if (exact !== undefined) return exact;
  if (LOCALLY_PROBED_PROVIDERS.has(provider)) return undefined;
  const bare = baseModelId(modelString);
  if (bare) {
    for (const [k, meta] of metadata) {
      if (meta.contextWindow !== undefined && baseModelId(k) === bare) {
        return meta.contextWindow;
      }
    }
  }
  return undefined;
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
   * Resolution (exact hit, guarded alias, base-model fallback) is
   * {@link resolveCatalogWindow}'s — see its doc for the local-provider
   * asymmetries.
   */
  async contextWindow(modelString: string): Promise<number | undefined> {
    if (this.#metadata) return resolveCatalogWindow(this.#metadata, modelString);
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
    // Mirror resolveCatalogWindow's local-provider guard: without a cloud
    // signal, ollama/* must not inherit ollama-cloud rates as "real" prices
    // (BUG-102) — free local sessions would accrue cloud spend and trip budgets.
    return resolveCatalogPrice(this.#metadata, modelString);
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
          const parsed = parseModelsDev(raw);
          // A wrong-shaped 200 (schema change / error envelope) parses to an
          // EMPTY map — treat it exactly like a fetch failure below, never poison
          // #metadata with it (see the no-poison rationale).
          if (parsed.size > 0) {
            this.#metadata = parsed;
            return this.#metadata;
          }
        }
        // Fetch failed / empty AND no usable cache: do NOT poison `#metadata` with
        // an empty map — that's truthy, so every later contextWindow()/pricing()
        // would take the fast path and never retry the network, pinning all models
        // to the 128k default + $0 pricing for the whole process. Clear the
        // in-flight promise so the NEXT lookup retries; return an empty map for
        // THIS call only.
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
      // Only persist a 200 that actually parses to models — a wrong-shaped body
      // (schema change / error envelope) must NOT be cached to disk, or it pins
      // every model to defaults for the full 24h TTL, surviving restarts.
      if (parseModelsDev(data).size === 0) throw new Error("empty/unrecognized catalog body");
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

/**
 * Long-context pricing tiers from a models.dev `cost` block. The `tiers` array is
 * the faithful source: each entry carries its REAL threshold (`tier.size`, which
 * varies — 200k for Gemini, 272k for GPT-5.x, 256k for Qwen). The
 * `context_over_200k` sibling is a lossy convenience field (always keyed to 200k
 * regardless of the true threshold), so we fall back to it only when `tiers` is
 * absent. Returns undefined when the model prices a big prompt flat, so untiered
 * models keep a `tiers`-free cost object.
 */
/** Coerce a models.dev price field to a FINITE number, or undefined. A malformed
 * upstream (a string, `null`, `NaN`, or `Infinity` price) must never reach the cost
 * math in `computeCost` — a `NaN` cost accumulates into the running spend and makes
 * every `costUSD > limitUSD` comparison false, silently disabling the budget `stop`
 * cap and rendering `NaN` in the UI. Normalize at the parse boundary so downstream
 * price consumers only ever see a real number or `undefined` (= "unpriced"). */
function finiteNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A context window / max-output must be a finite POSITIVE number to be usable.
 * A malformed upstream value (0, negative, NaN, a string) would otherwise flow
 * straight into `threshold * window` and break compaction/offload — a `0`
 * window makes every fill 0, a `NaN` makes the trigger never fire → the long
 * turn 400s. Coerce a bad value to undefined so the probe/default takes over. */
function finitePositive(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function parseTiers(cost: any): PricingTier[] | undefined {
  const raw = cost?.tiers;
  if (Array.isArray(raw)) {
    const tiers: PricingTier[] = [];
    for (const t of raw) {
      const size = t?.tier?.size;
      if (typeof size !== "number") continue;
      tiers.push({
        threshold: size,
        input: finiteNum(t?.input),
        output: finiteNum(t?.output),
        cacheRead: finiteNum(t?.cache_read),
        cacheWrite: finiteNum(t?.cache_write),
      });
    }
    // Ascending by threshold so tier selection can walk it as a step function.
    if (tiers.length) return tiers.sort((a, b) => a.threshold - b.threshold);
  }
  const over = cost?.context_over_200k;
  if (over && typeof over === "object") {
    return [
      {
        threshold: 200_000,
        input: finiteNum(over.input),
        output: finiteNum(over.output),
        cacheRead: finiteNum(over.cache_read),
        cacheWrite: finiteNum(over.cache_write),
      },
    ];
  }
  return undefined;
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
        contextWindow: finitePositive(m?.limit?.context),
        maxOutput: finitePositive(m?.limit?.output),
        cost: {
          input: finiteNum(m?.cost?.input),
          output: finiteNum(m?.cost?.output),
          cacheRead: finiteNum(m?.cost?.cache_read),
          cacheWrite: finiteNum(m?.cost?.cache_write),
          tiers: parseTiers(m?.cost),
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
