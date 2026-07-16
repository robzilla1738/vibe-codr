/**
 * Best-effort probe of an Ollama model's real context window via the native
 * `POST /api/show` endpoint (covers local `ollama serve` and Ollama Cloud, which
 * the models.dev catalog doesn't list for custom tags). Returns undefined on any
 * failure so callers fall back to the catalog / a default. Per-process memoized
 * so it never costs more than one request per model.
 */

const cache = new Map<string, number | undefined>();

interface ShowResponse {
  model_info?: Record<string, unknown>;
  parameters?: string;
}

/**
 * @param model   Full `ollama/<name>` model string.
 * @param baseURL The provider's OpenAI-compatible base (e.g. `.../v1`); the
 *                native API lives at the same host without the `/v1` suffix.
 * @param apiKey  Resolved Ollama API key from config/env/token resolution.
 */
export async function probeOllamaContextWindow(
  model: string,
  baseURL?: string,
  apiKey?: string,
): Promise<number | undefined> {
  const name = model.replace(/^ollama\//, "");
  const resolvedApiKey = apiKey ?? process.env.OLLAMA_API_KEY;
  // Route the probe to the SAME host the model runs on. Precedence: explicit
  // baseURL → $OLLAMA_BASE_URL → Ollama CLOUD (when an API key is set, so a cloud
  // user isn't misrouted to a localhost daemon that may not exist) → local daemon.
  const cloudDefault = resolvedApiKey ? "https://ollama.com" : "http://localhost:11434/v1";
  const root = (baseURL ?? process.env.OLLAMA_BASE_URL ?? cloudDefault)
    .replace(/\/v1\/?$/, "")
    .replace(/\/$/, "");
  const cacheKey = `${model}\0${root}\0${resolvedApiKey ? "auth" : "noauth"}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  try {
    const res = await fetch(`${root}/api/show`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(resolvedApiKey ? { authorization: `Bearer ${resolvedApiKey}` } : {}),
      },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(4000),
    });
    // Only a SUCCESSFUL response is a definitive answer worth memoizing. A
    // non-ok status (500, or the daemon still loading), a network error, or a
    // timeout is TRANSIENT — caching undefined there would permanently pin the
    // model to the default even after the daemon comes up, so leave it uncached
    // and let the next turn re-probe.
    if (!res.ok) return undefined;
    const ctx = extractContextLength((await res.json()) as ShowResponse);
    cache.set(cacheKey, ctx);
    return ctx;
  } catch {
    return undefined;
  }
}

/**
 * Pull the REAL served context window from a `/api/show` body. `model_info.*
 * .context_length` is the model's architectural maximum (from GGUF metadata),
 * but Ollama serves at most the Modelfile's `num_ctx` (often far lower, e.g. an
 * 8k default over a 128k-capable model). So when a `num_ctx` is configured, the
 * served window is `min(num_ctx, architectural)`; the architectural max alone
 * over-reports and would make the UI/compaction think there's headroom that a
 * request would actually 400 on. Falls back to whichever value is present.
 */
export function extractContextLength(data: ShowResponse): number | undefined {
  let architectural: number | undefined;
  for (const [k, v] of Object.entries(data.model_info ?? {})) {
    if (k.endsWith("context_length") && typeof v === "number" && v > 0) {
      architectural = v;
      break;
    }
  }
  let configured: number | undefined;
  if (data.parameters) {
    const m = /num_ctx\s+(\d+)/.exec(data.parameters);
    if (m && Number(m[1]) > 0) configured = Number(m[1]);
  }
  if (configured !== undefined && architectural !== undefined) {
    return Math.min(configured, architectural);
  }
  return configured ?? architectural;
}
