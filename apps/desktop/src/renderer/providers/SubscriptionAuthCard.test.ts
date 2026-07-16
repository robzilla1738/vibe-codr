import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_PROVIDERS,
  subscriptionProviderForRegistryId,
} from "../../shared/subscription-providers";

describe("subscription provider setup", () => {
  it("maps both Codex aliases to the ChatGPT subscription route", () => {
    expect(subscriptionProviderForRegistryId("codex")?.id).toBe("openai-codex");
    expect(subscriptionProviderForRegistryId("openai-codex")?.model)
      .toBe("openai-codex/gpt-5.3-codex");
  });

  it("uses one device-code action and exposes Grok 4.5 plus Grok Build", () => {
    const grok = SUBSCRIPTION_PROVIDERS.find((provider) => provider.id === "xai-oauth")!;
    expect(grok.authMethod).toBe("device");
    expect(grok.model).toBe("xai-oauth/grok-4.5");
    expect(grok.models.map((model) => model.id)).toEqual([
      "xai-oauth/grok-4.5",
      "xai-oauth/grok-build-0.1",
    ]);
  });
});
