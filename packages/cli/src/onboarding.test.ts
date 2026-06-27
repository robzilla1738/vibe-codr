import { test, expect, afterEach } from "bun:test";
import { defaultConfig } from "@vibe/config";
import { ProviderRegistry, type ProviderDef } from "@vibe/providers";
import { needsOnboarding, buildOnboardingPatch } from "./onboarding.ts";

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
