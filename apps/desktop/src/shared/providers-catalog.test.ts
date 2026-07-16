import { describe, expect, it } from "vitest";
import {
  buildOnboardingPatch,
  configuredCredentialProviderIds,
  hasUsableOnboardingProvider,
  initialChoiceIndex,
  PROVIDER_CHOICES,
  providerChoiceAcceptsApiKey,
  providerChoiceDefaultBaseURL,
  providerChoiceForId,
  providerChoiceNeedsApiKey,
} from "./providers-catalog";

describe("providers-catalog", () => {
  it("has unique choice keys", () => {
    const keys = PROVIDER_CHOICES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe("providerChoiceNeedsApiKey", () => {
    it("requires credentials for unconfigured remote providers", () => {
      const openai = PROVIDER_CHOICES.find((c) => c.key === "openai")!;
      expect(providerChoiceNeedsApiKey(openai)).toBe(true);
    });

    it("accepts detected credentials, local providers, and optional custom keys", () => {
      const codex = PROVIDER_CHOICES.find((c) => c.key === "openai-codex")!;
      const ollama = PROVIDER_CHOICES.find((c) => c.key === "ollama-local")!;
      const custom = PROVIDER_CHOICES.find((c) => c.key === "custom-endpoint")!;
      const grok = PROVIDER_CHOICES.find((c) => c.key === "xai-oauth")!;
      expect(providerChoiceNeedsApiKey(codex, new Set(["openai-codex"]))).toBe(false);
      expect(providerChoiceNeedsApiKey(codex)).toBe(false);
      expect(providerChoiceNeedsApiKey(grok)).toBe(false);
      expect(providerChoiceNeedsApiKey(ollama)).toBe(false);
      expect(providerChoiceNeedsApiKey(custom)).toBe(false);
      expect(providerChoiceAcceptsApiKey(custom)).toBe(true);
    });
  });

  describe("onboarding readiness", () => {
    it("does not treat an offline keyless provider as usable", () => {
      expect(hasUsableOnboardingProvider([
        { configured: true, keyless: true },
      ], [])).toBe(false);
    });

    it("accepts remote credentials or a live local model", () => {
      expect(hasUsableOnboardingProvider([
        { configured: true, keyless: false },
      ], [])).toBe(true);
      expect(hasUsableOnboardingProvider([
        { configured: true, keyless: true },
      ], [{ id: "local-model" }])).toBe(true);
    });

    it("does not let a shared keyless provider suppress cloud credentials", () => {
      expect(configuredCredentialProviderIds([
        { id: "ollama", configured: true, keyless: true },
        { id: "openai", configured: true, keyless: false },
      ])).toEqual(new Set(["openai"]));
    });
  });

  it("includes the major providers", () => {
    const ids = PROVIDER_CHOICES.map((c) => c.key);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    expect(ids).toContain("ollama-local");
    expect(ids).toContain("custom-endpoint");
    expect(ids).toContain("crof");
    expect(ids).toContain("xai-oauth");
  });

  it("keeps subscription providers in the short recommended setup view", () => {
    const codex = providerChoiceForId("openai-codex")!;
    const grok = providerChoiceForId("xai-oauth")!;
    expect(codex.featured).toBe(true);
    expect(codex.defaultModel).toBe("openai-codex/gpt-5.3-codex");
    expect(grok.featured).toBe(true);
    expect(grok.defaultModel).toBe("xai-oauth/grok-4.5");
  });

  it("promotes CrofAI with its official automatic endpoint and setup defaults", () => {
    const crof = providerChoiceForId("crof")!;
    expect(crof.key).toBe("crof");
    expect(crof.env).toBe("CROF_API_KEY");
    expect(crof.defaultModel).toBe("crof/glm-5.2");
    expect(providerChoiceDefaultBaseURL(crof)).toBe("https://crof.ai/v1");
  });

  it("covers the complete OpenCode models.dev registry plus Hermes aliases", () => {
    const providerIds = new Set(PROVIDER_CHOICES.map((choice) => choice.registryId));
    expect(providerIds.size).toBeGreaterThanOrEqual(166);
    for (const id of [
      "amazon-bedrock",
      "azure",
      "google-vertex",
      "github-copilot",
      "alibaba-coding-plan",
      "novita-ai",
      "xiaomi",
      "stepfun",
      "opencode",
    ]) {
      expect(providerIds.has(id)).toBe(true);
    }
  });

  it("marks native deployment providers as requiring an endpoint in onboarding", () => {
    const azure = PROVIDER_CHOICES.find((choice) => choice.registryId === "azure")!;
    expect(azure.requiresBaseURL).toBe(true);
  });

  it("keyless choices have localKeyless set", () => {
    const local = PROVIDER_CHOICES.filter((c) => c.localKeyless);
    expect(local.every((c) => !c.keyUrl)).toBe(true);
  });

  describe("initialChoiceIndex", () => {
    it("returns 0 when nothing is configured", () => {
      expect(initialChoiceIndex(PROVIDER_CHOICES, {})).toBe(0);
    });

    it("detects an env var match", () => {
      const idx = initialChoiceIndex(PROVIDER_CHOICES, { OPENAI_API_KEY: "sk-1" });
      expect(PROVIDER_CHOICES[idx]!.key).toBe("openai");
    });

    it("detects a configured provider id", () => {
      const idx = initialChoiceIndex(PROVIDER_CHOICES, {}, new Set(["ollama"]));
      // ollama-cloud is the first non-keyless choice with registryId "ollama"
      expect(PROVIDER_CHOICES[idx]!.registryId).toBe("ollama");
    });

    it("skips keyless choices for env detection", () => {
      const idx = initialChoiceIndex(PROVIDER_CHOICES, { OLLAMA_BASE_URL: "http://x" });
      // ollama-local is keyless — should be skipped, falling back to 0
      expect(idx).toBe(0);
    });
  });

  describe("buildOnboardingPatch", () => {
    it("builds a model + provider patch with an API key", () => {
      expect(
        buildOnboardingPatch({
          model: "openai/gpt-5.5",
          providerId: "openai",
          apiKey: "sk-1",
        }),
      ).toEqual({
        model: "openai/gpt-5.5",
        providers: { openai: { apiKey: "sk-1" } },
      });
    });

    it("includes baseURL for custom endpoints", () => {
      expect(
        buildOnboardingPatch({
          model: "custom/my-model",
          providerId: "custom",
          apiKey: "sk-1",
          baseURL: "https://my.api/v1",
        }),
      ).toEqual({
        model: "custom/my-model",
        providers: { custom: { apiKey: "sk-1", baseURL: "https://my.api/v1" } },
      });
    });

    it("preserves custom transport and explicit models from guided setup", () => {
      expect(
        buildOnboardingPatch({
          model: "team-gateway/model-a",
          providerId: "team-gateway",
          baseURL: "https://gateway.example.com/v1",
          transport: "openai-responses",
          models: ["model-a"],
        }),
      ).toEqual({
        model: "team-gateway/model-a",
        providers: {
          "team-gateway": {
            baseURL: "https://gateway.example.com/v1",
            transport: "openai-responses",
            models: ["model-a"],
          },
        },
      });
    });

    it("only sets model for keyless providers", () => {
      expect(
        buildOnboardingPatch({
          model: "ollama/gpt-oss:20b",
          providerId: "ollama",
        }),
      ).toEqual({ model: "ollama/gpt-oss:20b" });
    });
  });
});
