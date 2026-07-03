/**
 * Best-effort probe of an LM Studio model's real context window via LM Studio's
 * native REST API (`GET /api/v0/models`), which reports `loaded_context_length`
 * (the window the model is actually SERVED at) and `max_context_length`. The
 * models.dev catalog doesn't list local model ids, so without this an LM Studio
 * model falls through to the 128k default — catastrophic for a 4k/8k local model
 * (the context never triggers compaction and every long turn 400s or is silently
 * truncated). Returns undefined on any failure so callers fall back to the
 * catalog / config override / default. Per-process memoized.
 */

const cache = new Map<string, number | undefined>();

interface LmStudioModel {
  id?: string;
  loaded_context_length?: number;
  max_context_length?: number;
}

/**
 * @param model   Full `lmstudio/<name>` model string.
 * @param baseURL The provider's OpenAI-compatible base (e.g. `http://localhost:1234/v1`);
 *                the native API lives at the same host without the `/v1` suffix.
 */
export async function probeLmStudioContextWindow(
  model: string,
  baseURL?: string,
): Promise<number | undefined> {
  if (cache.has(model)) return cache.get(model);
  const name = model.replace(/^lmstudio\//, "");
  const root = (baseURL ?? process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1")
    .replace(/\/v1\/?$/, "")
    .replace(/\/$/, "");
  try {
    const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(4000) });
    // Only a SUCCESSFUL response is a definitive answer worth memoizing — a
    // transient error (server loading, network, timeout) must not permanently
    // pin the model to the default; let the next turn re-probe.
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: LmStudioModel[] };
    const ctx = extractLmStudioContext(body.data ?? [], name);
    cache.set(model, ctx);
    return ctx;
  } catch {
    return undefined;
  }
}

/**
 * The SERVED window for `name` from an `/api/v0/models` list. Prefers
 * `loaded_context_length` (what the model is actually running at — often far
 * below its max) over `max_context_length`; the max alone would over-report a
 * window a request would 400 on. Returns undefined when the model isn't listed.
 */
export function extractLmStudioContext(models: LmStudioModel[], name: string): number | undefined {
  const m = models.find((x) => x.id === name);
  if (!m) return undefined;
  const loaded = typeof m.loaded_context_length === "number" && m.loaded_context_length > 0
    ? m.loaded_context_length
    : undefined;
  const max = typeof m.max_context_length === "number" && m.max_context_length > 0
    ? m.max_context_length
    : undefined;
  if (loaded !== undefined && max !== undefined) return Math.min(loaded, max);
  return loaded ?? max;
}
