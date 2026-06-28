import { test, expect, afterEach } from "bun:test";
import { defaultConfig } from "@vibe/config";
import { ProviderRegistry, type ProviderDef } from "@vibe/providers";
import {
  needsOnboarding,
  buildOnboardingPatch,
  PROVIDER_CHOICES,
  initialChoiceIndex,
} from "./onboarding.ts";

const stub = (id: string, env: string[], keyless = false): ProviderDef => ({
  id,
  auth: keyless ? { env, keyless: true } : { env },
  create: () => ({}) as never,
  listModels: async () => [],
});

const registry = new ProviderRegistry([
  stub("anthropic", ["ANTHROPIC_API_KEY"]),
  stub("lmstudio", [], true),
]);

const realKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
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

test("no onboarding for an unknown provider (handled by normal errors)", () => {
  const config = { ...defaultConfig(), model: "mystery/x" };
  expect(needsOnboarding(config, registry)).toBe(false);
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

  expect(
    buildOnboardingPatch({ model: "lmstudio/x", providerId: "lmstudio" }),
  ).toEqual({ model: "lmstudio/x" });
});

test("Ollama Cloud is offered as a key-required choice on the `ollama` provider", () => {
  const cloud = PROVIDER_CHOICES.find((c) => c.key === "ollama-cloud");
  expect(cloud).toBeDefined();
  // Maps onto the real provider, carries the cloud key var, and is NOT keyless
  // (so onboarding prompts for the subscription key even though local is keyless).
  expect(cloud?.registryId).toBe("ollama");
  expect(cloud?.env).toBe("OLLAMA_API_KEY");
  expect(cloud?.cloud).toBe(true);
  expect(cloud?.localKeyless).toBeUndefined();
  expect(cloud?.defaultModel).toMatch(/^ollama\//);
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

test("initialChoiceIndex preselects the provider whose key is in the env", () => {
  const ollamaCloud = PROVIDER_CHOICES.findIndex((c) => c.key === "ollama-cloud");
  expect(initialChoiceIndex(PROVIDER_CHOICES, { OLLAMA_API_KEY: "x" })).toBe(
    ollamaCloud,
  );
  // Local-keyless providers never auto-win (their env var is just a base URL).
  expect(
    initialChoiceIndex(PROVIDER_CHOICES, { OLLAMA_BASE_URL: "http://x" }),
  ).toBe(0);
  expect(initialChoiceIndex(PROVIDER_CHOICES, {})).toBe(0);
});
