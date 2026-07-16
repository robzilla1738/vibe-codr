#!/usr/bin/env node

export {};

const rawModels = process.argv[2];
if (!rawModels) throw new Error("usage: vibe-cloud-model-probe <models-json>");
const models = JSON.parse(rawModels) as unknown;
if (!Array.isArray(models) || !models.every((model) => typeof model === "string")) {
  throw new Error("cloud model probe requires a JSON array of model strings");
}

const ollamaModels = [...new Set(models
  .filter((model) => model.startsWith("ollama/"))
  .map((model) => model.slice("ollama/".length))
  .filter(Boolean))];

if (ollamaModels.length > 0) await verifyOllamaCloudModels(ollamaModels);

async function verifyOllamaCloudModels(expected: string[]): Promise<void> {
  const key = process.env.OLLAMA_API_KEY;
  if (!key) throw new Error("Ollama Cloud handoff is missing OLLAMA_API_KEY");
  const baseURL = (process.env.OLLAMA_BASE_URL || "https://ollama.com/v1").replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(`${baseURL}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Ollama Cloud is unreachable from the sandbox: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Ollama Cloud credential check failed with HTTP ${response.status}`);
  }
  const body = await response.json() as { data?: Array<{ id?: unknown }> };
  const available = new Set((body.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === "string"));
  const missing = expected.filter((model) => !available.has(model));
  if (missing.length > 0) {
    throw new Error(`Ollama Cloud does not provide the exact session model${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  }
}
