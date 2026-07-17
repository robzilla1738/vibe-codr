#!/usr/bin/env node
import { defaultConfig } from "@vibe/config";
import { ProviderRegistry } from "@vibe/providers";
import { generateText } from "ai";
import { openCloudModelAccess } from "@vibe/shared/cloud-runtime";
import { readFileSync } from "node:fs";

const [envelopePath, workspace, expectedSessionId] = process.argv.slice(2);
if (!envelopePath || !workspace || !expectedSessionId) {
  throw new Error("usage: vibe-cloud-model-probe <model-access-envelope> <workspace> <session-id>");
}
const accessToken = process.env.VIBE_CLOUD_ACCESS_TOKEN;
if (!accessToken) throw new Error("missing-credential: cloud model probe access token is unavailable");
const modelAccess = openCloudModelAccess(
  JSON.parse(readFileSync(envelopePath, "utf8")),
  accessToken,
  expectedSessionId,
);
for (const [name, value] of Object.entries(modelAccess.environment)) process.env[name] = value;
delete process.env.VIBE_CLOUD_ACCESS_TOKEN;
const models = modelAccess.profile.requiredModels;
// Provider credentials, endpoint overrides, and arbitrary-provider transport
// are already reduced to reviewed environment bindings by the desktop. Avoid
// reading Mac-global config here: it is intentionally absent in Cloud, and the
// production probe runs under bundled Node rather than Bun.
const config = defaultConfig();
const registry = new ProviderRegistry();

// A model-list response does not prove that a credential is valid or that the
// model's generation endpoint is reachable. Exercise the same provider registry
// and LanguageModel path the imported agent will use, with a deliberately tiny
// output budget. Two workers keep multi-model handoffs bounded without sending a
// burst of requests through one account.
await runBounded(models, 2, async (model) => {
  try {
    const languageModel = await registry.resolveModel(model, config);
    await generateText({
      model: languageModel,
      prompt: "Reply with OK.",
      maxOutputTokens: 8,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60_000),
      ...(model.endsWith("/grok-4.5")
        ? { providerOptions: { openai: { store: false, reasoningEffort: "low" } } }
        : {}),
    });
  } catch (error) {
    throw new Error(formatProbeError(model, error), { cause: error });
  }
});

async function runBounded<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (index < values.length) {
        const value = values[index++];
        if (value !== undefined) await task(value);
      }
    }),
  );
}

function formatProbeError(model: string, error: unknown): string {
  const details = errorDetails(error);
  const route = details.url ? ` at ${safeRoute(details.url)}` : "";
  const status = details.statusCode ? ` (HTTP ${details.statusCode})` : "";
  const cause = details.causeCode ? ` [${details.causeCode}]` : "";
  return `Cloud model preflight failed for ${model}${route}${status}${cause}: ${details.message}`;
}

function errorDetails(error: unknown): {
  message: string;
  url?: string;
  statusCode?: number;
  causeCode?: string;
} {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const cause =
    value.cause && typeof value.cause === "object" ? (value.cause as Record<string, unknown>) : {};
  const message = error instanceof Error ? error.message : String(error);
  const url =
    typeof value.url === "string"
      ? value.url
      : typeof cause.url === "string"
        ? cause.url
        : undefined;
  const statusCode =
    typeof value.statusCode === "number"
      ? value.statusCode
      : typeof cause.statusCode === "number"
        ? cause.statusCode
        : undefined;
  const causeCode = typeof cause.code === "string" ? cause.code : undefined;
  return {
    message,
    ...(url ? { url } : {}),
    ...(statusCode ? { statusCode } : {}),
    ...(causeCode ? { causeCode } : {}),
  };
}

function safeRoute(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return "the configured provider endpoint";
  }
}
