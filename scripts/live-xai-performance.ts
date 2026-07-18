import { defaultConfig } from "@vibe/config";
import { buildModelTuning } from "../packages/core/src/model-tuning.ts";
import { ProviderRegistry } from "@vibe/providers";
import { streamText } from "ai";
import { performance } from "node:perf_hooks";

if (process.env.VIBE_LIVE_PERF !== "1") {
  throw new Error("Paid live performance canary is disabled; set VIBE_LIVE_PERF=1 explicitly.");
}

const modelName = process.env.VIBE_LIVE_PERF_MODEL ?? "xai/grok-4.5";
if (modelName !== "xai/grok-4.5" && modelName !== "xai-oauth/grok-4.5") {
  throw new Error("VIBE_LIVE_PERF_MODEL must be xai/grok-4.5 or xai-oauth/grok-4.5");
}
const prompt = "Reply with exactly the word READY.";
const system = "You are a deterministic latency canary. Follow the user's requested output exactly.";
const registry = new ProviderRegistry();

async function sample(tier: "default" | "priority", pass: number) {
  const config = defaultConfig();
  config.latency.providerTier = tier;
  const model = await registry.resolveModel(modelName, config);
  const tuning = buildModelTuning(modelName, config, { sessionId: "live-perf-canary" });
  const started = performance.now();
  let ttftMs: number | undefined;
  let usage: Record<string, unknown> | undefined;
  const result = streamText({
    model,
    system,
    prompt,
    maxRetries: config.retry.maxAttempts,
    providerOptions: tuning.providerOptions,
  });
  for await (const raw of result.fullStream as AsyncIterable<Record<string, unknown>>) {
    if (
      ttftMs === undefined &&
      (raw.type === "text-delta" || raw.type === "reasoning-delta")
    ) {
      ttftMs = performance.now() - started;
    }
    if (raw.type === "finish" && raw.usage && typeof raw.usage === "object") {
      usage = raw.usage as Record<string, unknown>;
    }
  }
  return {
    tier,
    pass,
    ttftMs,
    totalMs: performance.now() - started,
    inputTokens: usage?.inputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    outputTokens: usage?.outputTokens,
  };
}

const samples = [];
for (const tier of ["default", "priority"] as const) {
  // Two identical calls per tier expose the warm prompt-cache behavior without
  // changing system text, prompt, reasoning, storage, retries, or model.
  samples.push(await sample(tier, 1));
  samples.push(await sample(tier, 2));
}
console.info("VIBE_LIVE_PERFORMANCE_RESULT", JSON.stringify({ model: modelName, samples }));
