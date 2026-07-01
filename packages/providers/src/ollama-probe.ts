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
 */
export async function probeOllamaContextWindow(
  model: string,
  baseURL?: string,
): Promise<number | undefined> {
  if (cache.has(model)) return cache.get(model);
  const name = model.replace(/^ollama\//, "");
  const root = (baseURL ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1")
    .replace(/\/v1\/?$/, "")
    .replace(/\/$/, "");
  try {
    const apiKey = process.env.OLLAMA_API_KEY;
    const res = await fetch(`${root}/api/show`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      cache.set(model, undefined);
      return undefined;
    }
    const ctx = extractContextLength((await res.json()) as ShowResponse);
    cache.set(model, ctx);
    return ctx;
  } catch {
    cache.set(model, undefined);
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
