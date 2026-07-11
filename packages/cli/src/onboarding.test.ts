import { test, expect, afterEach } from "bun:test";
import { defaultConfig } from "@vibe/config";
import { ProviderRegistry, type ProviderDef } from "@vibe/providers";
import {
  needsOnboarding,
  buildOnboardingPatch,
  PROVIDER_CHOICES,
  initialChoiceIndex,
  choiceIsConfigured,
  modelListOptions,
} from "./onboarding.ts";

const stub = (
  id: string,
  env: string[],
  keyless = false,
  auth: Partial<ProviderDef["auth"]> = {},
): ProviderDef => ({
  id,
  auth: keyless ? { env, keyless: true, ...auth } : { env, ...auth },
  create: () => ({}) as never,
  listModels: async () => [],
});

const registry = new ProviderRegistry([
  stub("anthropic", ["ANTHROPIC_API_KEY"]),
  stub("lmstudio", [], true),
  stub("ollama", ["OLLAMA_API_KEY"], true),
  stub("custom", ["CUSTOM_API_KEY"], true, {
    baseURLEnv: "CUSTOM_BASE_URL",
    requiresBaseURL: true,
  }),
]);

const realKey = process.env.ANTHROPIC_API_KEY;
const realOllamaKey = process.env.OLLAMA_API_KEY;
const realCustomBaseURL = process.env.CUSTOM_BASE_URL;
afterEach(() => {
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
  if (realOllamaKey === undefined) delete process.env.OLLAMA_API_KEY;
  else process.env.OLLAMA_API_KEY = realOllamaKey;
  if (realCustomBaseURL === undefined) delete process.env.CUSTOM_BASE_URL;
  else process.env.CUSTOM_BASE_URL = realCustomBaseURL;
});

test("needs onboarding when the model's provider has no key", () => {
  delete process.env.ANTHROPIC_API_KEY;
  const config = { ...defaultConfig(), model: "anthropic/claude-opus-4-8" };
  expect(needsOnboarding(config, registry)).toBe(true);
});

test("no onboarding once a key is present in config", () => {
  delete process.env.ANTHROPIC_API_KEY;
  const config = {
    ...defaultConfig(),
    model: "anthropic/claude-opus-4-8",
    providers: { anthropic: { apiKey: "sk-test" } },
  };
  expect(needsOnboarding(config, registry)).toBe(false);
});

test("no onboarding for a keyless provider (e.g. LM Studio)", () => {
  const config = { ...defaultConfig(), model: "lmstudio/qwen" };
  expect(needsOnboarding(config, registry)).toBe(false);
});

test("custom endpoint needs onboarding until a base URL is configured", () => {
  delete process.env.CUSTOM_BASE_URL;
  expect(needsOnboarding({ ...defaultConfig(), model: "custom/foo" }, registry)).toBe(true);
  expect(
    needsOnboarding(
      {
        ...defaultConfig(),
        model: "custom/foo",
        providers: { custom: { baseURL: "https://endpoint.example.com/v1" } },
      },
      registry,
    ),
  ).toBe(false);
  process.env.CUSTOM_BASE_URL = "https://env-endpoint.example.com/v1";
  expect(needsOnboarding({ ...defaultConfig(), model: "custom/foo" }, registry)).toBe(false);
});

test("no onboarding for an unknown provider (handled by normal errors)", () => {
  const config = { ...defaultConfig(), model: "mystery/x" };
  expect(needsOnboarding(config, registry)).toBe(false);
});

test("malformed model strings for known providers reopen onboarding", () => {
  delete process.env.ANTHROPIC_API_KEY;
  expect(needsOnboarding({ ...defaultConfig(), model: "anthropic" }, registry)).toBe(true);
  expect(needsOnboarding({ ...defaultConfig(), model: "anthropic/" }, registry)).toBe(true);
  expect(needsOnboarding({ ...defaultConfig(), model: "lmstudio" }, registry)).toBe(true);
});

test("malformed model strings for unknown providers still fall through to normal errors", () => {
  expect(needsOnboarding({ ...defaultConfig(), model: "mystery" }, registry)).toBe(false);
  expect(needsOnboarding({ ...defaultConfig(), model: "/missing-provider" }, registry)).toBe(false);
});

test("buildOnboardingPatch includes keys only when provided", () => {
  expect(
    buildOnboardingPatch({
      model: "anthropic/claude-opus-4-8",
      providerId: "anthropic",
      apiKey: "sk",
      searchKey: "tf",
    }),
  ).toEqual({
    model: "anthropic/claude-opus-4-8",
    providers: { anthropic: { apiKey: "sk" } },
    search: { apiKey: "tf" },
  });

  expect(buildOnboardingPatch({ model: "lmstudio/x", providerId: "lmstudio" })).toEqual({
    model: "lmstudio/x",
  });
});

test("buildOnboardingPatch persists a base URL for a custom OpenAI-compatible endpoint", () => {
  expect(
    buildOnboardingPatch({
      model: "custom/my-model",
      providerId: "custom",
      apiKey: "k",
      baseURL: "https://my-endpoint.example.com/v1",
    }),
  ).toEqual({
    model: "custom/my-model",
    providers: { custom: { apiKey: "k", baseURL: "https://my-endpoint.example.com/v1" } },
  });
  // A keyless custom endpoint still persists its base URL.
  expect(
    buildOnboardingPatch({
      model: "custom/m",
      providerId: "custom",
      baseURL: "http://localhost:8080/v1",
    }),
  ).toEqual({
    model: "custom/m",
    providers: { custom: { baseURL: "http://localhost:8080/v1" } },
  });
});

test("the new providers + custom endpoint appear in the onboarding menu", () => {
  const keys = new Set(PROVIDER_CHOICES.map((c) => c.key));
  for (const k of [
    "google",
    "groq",
    "mistral",
    "together",
    "cerebras",
    "perplexity",
    "codex",
    "minimax",
    "fireworks",
    "zai",
    "moonshot",
    "alibaba",
    "huggingface",
    "meta",
    "custom-endpoint",
  ]) {
    expect(keys.has(k)).toBe(true);
  }
  const meta = PROVIDER_CHOICES.find((c) => c.key === "meta");
  expect(meta?.registryId).toBe("meta");
  expect(meta?.env).toBe("MODEL_API_KEY");
  expect(meta?.defaultModel).toBe("meta/muse-spark-1.1");
  // The custom endpoint maps to the real `custom` provider and is flagged.
  const custom = PROVIDER_CHOICES.find((c) => c.key === "custom-endpoint");
  expect(custom?.registryId).toBe("custom");
  expect(custom?.customEndpoint).toBe(true);
  // Every non-advanced choice maps to a registered provider id.
  expect(PROVIDER_CHOICES.find((c) => c.key === "codex")?.registryId).toBe("codex");
});

test("Ollama Cloud is offered as a key-required choice on the `ollama` provider", () => {
  const cloud = PROVIDER_CHOICES.find((c) => c.key === "ollama-cloud");
  expect(cloud).toBeDefined();
  // Maps onto the real provider, carries the cloud key var, and is NOT keyless
  // (so onboarding prompts for the subscription key even though local is keyless).
  expect(cloud?.registryId).toBe("ollama");
  expect(cloud?.env).toBe("OLLAMA_API_KEY");
  expect(cloud?.localKeyless).toBeUndefined();
  expect(cloud?.defaultModel).toMatch(/^ollama\//);
});

test("Ollama Cloud choice requires an actual key despite the local keyless provider", () => {
  delete process.env.OLLAMA_API_KEY;
  const cloud = PROVIDER_CHOICES.find((c) => c.key === "ollama-cloud")!;
  const local = PROVIDER_CHOICES.find((c) => c.key === "ollama-local")!;
  expect(choiceIsConfigured(cloud, defaultConfig(), registry)).toBe(false);
  expect(choiceIsConfigured(local, defaultConfig(), registry)).toBe(true);
  expect(
    choiceIsConfigured(
      cloud,
      { ...defaultConfig(), providers: { ollama: { apiKey: "ol-saved" } } },
      registry,
    ),
  ).toBe(true);
  process.env.OLLAMA_API_KEY = "ol-env";
  expect(choiceIsConfigured(cloud, defaultConfig(), registry)).toBe(true);
});

test("an Ollama Cloud key persists onto the ollama provider (enables cloud URL)", () => {
  // The registry swaps to ollama.com when providers.ollama.apiKey is set.
  expect(
    buildOnboardingPatch({
      model: "ollama/gpt-oss:120b-cloud",
      providerId: "ollama",
      apiKey: "ol-cloud-key",
    }),
  ).toEqual({
    model: "ollama/gpt-oss:120b-cloud",
    providers: { ollama: { apiKey: "ol-cloud-key" } },
  });
});

test("Ollama local model listing does not inherit cloud credentials", () => {
  process.env.OLLAMA_API_KEY = "ol-env";
  const local = PROVIDER_CHOICES.find((c) => c.key === "ollama-local")!;
  const cloud = PROVIDER_CHOICES.find((c) => c.key === "ollama-cloud")!;
  const config = {
    ...defaultConfig(),
    providers: { ollama: { apiKey: "ol-saved", baseURL: "http://local.example:11434/v1" } },
  };

  expect(modelListOptions(registry, local, config, process.env.OLLAMA_API_KEY)).toEqual({
    baseURL: "http://local.example:11434/v1",
  });
  expect(modelListOptions(registry, cloud, config, process.env.OLLAMA_API_KEY)).toEqual({
    apiKey: "ol-env",
  });
});

test("initialChoiceIndex preselects the provider whose key is in the env", () => {
  const ollamaCloud = PROVIDER_CHOICES.findIndex((c) => c.key === "ollama-cloud");
  expect(initialChoiceIndex(PROVIDER_CHOICES, { OLLAMA_API_KEY: "x" })).toBe(ollamaCloud);
  // Local-keyless providers never auto-win (their env var is just a base URL).
  expect(initialChoiceIndex(PROVIDER_CHOICES, { OLLAMA_BASE_URL: "http://x" })).toBe(0);
  expect(initialChoiceIndex(PROVIDER_CHOICES, {})).toBe(0);
});

test("initialChoiceIndex preselects a provider configured without its env var", () => {
  // codex is configured by ~/.codex/auth.json — no CODEX_API_KEY in the env.
  const codex = PROVIDER_CHOICES.findIndex((c) => c.key === "codex");
  expect(initialChoiceIndex(PROVIDER_CHOICES, {}, new Set(["codex"]))).toBe(codex);
  // An env-var hit still wins when it comes first in the menu.
  expect(initialChoiceIndex(PROVIDER_CHOICES, { ANTHROPIC_API_KEY: "x" }, new Set(["codex"]))).toBe(
    0,
  );
  // The custom-endpoint and "Other / advanced" rows never auto-win.
  expect(initialChoiceIndex(PROVIDER_CHOICES, {}, new Set(["custom", ""]))).toBe(0);
});
