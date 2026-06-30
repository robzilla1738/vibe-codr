import type { ModelInfo } from "./types.ts";

/**
 * Fetch models from any OpenAI-compatible `/v1/models` endpoint. Returns []
 * on any failure so a single unreachable provider never breaks the catalog.
 */
export async function listOpenAICompatibleModels(
  providerId: string,
  baseURL: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<ModelInfo[]> {
  try {
    // Caller-supplied headers (e.g. a gateway account id) first, so the standard
    // Accept/Authorization below take precedence over any collision.
    const headers: Record<string, string> = { ...extraHeaders, Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
      headers,
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const data = Array.isArray(json.data) ? json.data : [];
    return data
      .filter((m): m is { id: string } => typeof m.id === "string")
      .map((m) => ({ id: m.id, providerId }));
  } catch {
    return [];
  }
}
