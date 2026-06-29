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

/** Pull the context length from a `/api/show` body (model_info or num_ctx param). */
export function extractContextLength(data: ShowResponse): number | undefined {
  for (const [k, v] of Object.entries(data.model_info ?? {})) {
    if (k.endsWith("context_length") && typeof v === "number" && v > 0) return v;
  }
  if (data.parameters) {
    const m = /num_ctx\s+(\d+)/.exec(data.parameters);
    if (m) return Number(m[1]);
  }
  return undefined;
}
