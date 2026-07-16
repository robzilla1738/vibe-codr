import { describe, expect, it } from "vitest";
import {
  ambientCloudModelEnvironment,
  cloudModelEnvironment,
  cloudModelRouteHostname,
  configuredCloudFallbackModels,
  configuredCloudModels,
  subscriptionAuthProviderForModelProvider,
  subscriptionCredentialEnvironment,
} from "./model-environment";

describe("cloud model environment", () => {
  it("automatically selects only ambient credentials used by configured Cloud models", () => {
    expect(ambientCloudModelEnvironment(
      ["crof/glm-5.2", "xai-oauth/grok-4.5"],
      {
        CROF_API_KEY: "crof-secret",
        XAI_API_KEY: "xai-secret",
        XAI_BASE_URL: "https://api.x.ai/v1",
        OPENAI_API_KEY: "unrelated-secret",
        SSH_AUTH_SOCK: "/private/socket",
      },
    )).toEqual({
      CROF_API_KEY: "crof-secret",
      XAI_API_KEY: "xai-secret",
    });
  });

  it("maps both Codex aliases and xAI to transferable subscription bindings", () => {
    expect(subscriptionAuthProviderForModelProvider("codex")).toBe("openai-codex");
    expect(subscriptionAuthProviderForModelProvider("openai-codex")).toBe("openai-codex");
    expect(subscriptionAuthProviderForModelProvider("xai-oauth")).toBe("xai-oauth");
    expect(subscriptionAuthProviderForModelProvider("openai")).toBeNull();
    expect(subscriptionCredentialEnvironment("openai-codex", {
      access: "codex-access",
      accountId: "account-1",
    })).toEqual({
      VIBE_CODEX_OAUTH_TOKEN: "codex-access",
      CODEX_ACCOUNT_ID: "account-1",
    });
    expect(subscriptionCredentialEnvironment("xai-oauth", { access: "xai-access" }))
      .toEqual({ XAI_API_KEY: "xai-access" });
  });
  it("injects only the active provider credential", () => {
    expect(cloudModelEnvironment("ollama/glm-5.2", {
      providers: {
        ollama: { apiKey: "ollama-secret" },
        openai: { apiKey: "unrelated-secret" },
      },
    }, undefined, {})).toEqual({
      OLLAMA_API_KEY: "ollama-secret",
      OLLAMA_BASE_URL: "https://ollama.com/v1",
    });
    expect(cloudModelEnvironment("crof/glm-5.2", {
      providers: { crof: { apiKey: "crof-secret" } },
    }, undefined, {})).toEqual({ CROF_API_KEY: "crof-secret" });
  });

  it("prefers an explicit session binding over the config key", () => {
    expect(cloudModelEnvironment("openai/gpt-5.5", {
      providers: { openai: { apiKey: "config-secret" } },
    }, undefined, { OPENAI_API_KEY: "bound-secret" })).toEqual({
      OPENAI_API_KEY: "bound-secret",
    });
  });

  it("keeps documented provider aliases and rejects local credential chains", () => {
    expect(cloudModelEnvironment("codex/gpt-5.3-codex", undefined, undefined, {
      VIBE_CODEX_OAUTH_TOKEN: "codex-oauth-token",
    })).toEqual({ VIBE_CODEX_OAUTH_TOKEN: "codex-oauth-token" });
    expect(() => cloudModelEnvironment("bedrock/claude", undefined, undefined, {
      AWS_ACCESS_KEY_ID: "local-chain",
    })).toThrow("credential chain from this Mac");
  });

  it("preserves explicit bindings while resolving the active provider", () => {
    expect(cloudModelEnvironment("openai/gpt-5.5", undefined, undefined, {
      OPENAI_API_KEY: "active-secret",
      GITHUB_TOKEN: "unrelated-secret",
      ANTHROPIC_API_KEY: "other-provider-secret",
    })).toEqual({
      GITHUB_TOKEN: "unrelated-secret",
      ANTHROPIC_API_KEY: "other-provider-secret",
      OPENAI_API_KEY: "active-secret",
    });
  });

  it("keeps explicit integration bindings but selects one provider auth alias", () => {
    expect(cloudModelEnvironment("codex/gpt-5.3-codex", undefined, undefined, {
      VIBE_CODEX_OAUTH_TOKEN: "subscription-secret",
      OPENAI_API_KEY: "unrelated-public-api-key",
      GITHUB_TOKEN: "git-secret",
    })).toEqual({
      OPENAI_API_KEY: "unrelated-public-api-key",
      GITHUB_TOKEN: "git-secret",
      VIBE_CODEX_OAUTH_TOKEN: "subscription-secret",
    });
    expect(cloudModelEnvironment("amazon-bedrock/claude", undefined, undefined, {
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "session",
    })).toEqual({
      AWS_SESSION_TOKEN: "session",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
  });

  it("uses project provider settings only after global trust", () => {
    const project = { providers: { openai: { apiKey: "project-secret" } } };
    expect(() => cloudModelEnvironment("openai/gpt-5.5", {}, project, {}))
      .toThrow("needs a openai model credential");
    expect(cloudModelEnvironment("openai/gpt-5.5", {
      security: { trustProjectConfig: true },
    }, project, {})).toEqual({ OPENAI_API_KEY: "project-secret" });
  });

  it("blocks manifest and configured local-network routes", () => {
    expect(() => cloudModelEnvironment("atomic-chat/gemma", {
      providers: { "atomic-chat": { apiKey: "secret" } },
    }, undefined, {})).toThrow("Cloud sandbox cannot reach");
    expect(() => cloudModelEnvironment("custom/model", {
      providers: { custom: { apiKey: "secret", baseURL: "http://192.168.1.5:8080/v1" } },
    }, undefined, { CUSTOM_API_KEY: "secret" })).toThrow("Cloud sandbox cannot reach");
    expect(() => cloudModelEnvironment("ollama/glm-5.2", undefined, undefined, {
      OLLAMA_API_KEY: "secret",
      OLLAMA_BASE_URL: "http://localhost:11434/v1",
    })).toThrow("Cloud sandbox cannot reach");
    expect(() => cloudModelEnvironment("custom/model", undefined, undefined, {
      CUSTOM_API_KEY: "secret",
      CUSTOM_BASE_URL: "not a url",
    })).toThrow("invalid provider endpoint");
    expect(() => cloudModelEnvironment("custom/model", undefined, undefined, {
      CUSTOM_API_KEY: "secret",
      CUSTOM_BASE_URL: "http://provider.example.com/v1",
    })).toThrow("must use an HTTPS provider endpoint");
    expect(cloudModelEnvironment("openai-api/gpt-5.5", undefined, undefined, {
      OPENAI_API_KEY: "secret",
      OPENAI_BASE_URL: "https://regional.example.com/v1",
    })).toEqual({
      OPENAI_API_KEY: "secret",
      OPENAI_BASE_URL: "https://regional.example.com/v1",
    });
    expect(cloudModelRouteHostname("openai-api/gpt-5.5", undefined, undefined, {
      OPENAI_BASE_URL: "https://regional.example.com/v1",
    })).toBe("regional.example.com");
    expect(cloudModelRouteHostname("openai-api/gpt-5.5", undefined, undefined, {
      OPENAI_BASE_URL: "https://features.example.com/v1",
    })).toBe("features.example.com");
    expect(cloudModelRouteHostname("ollama/glm-5.2", undefined, undefined, {
      OLLAMA_API_KEY: "secret",
    })).toBe("ollama.com");
    expect(cloudModelEnvironment("ollama/gemma4:31b", undefined, undefined, {
      OLLAMA_API_KEY: "secret",
    })).toEqual({
      OLLAMA_API_KEY: "secret",
      OLLAMA_BASE_URL: "https://ollama.com/v1",
    });
  });

  it("collects every model the imported engine can select", () => {
    expect(configuredCloudModels({
      model: "openai/main",
      planModel: "anthropic/plan",
      modelFallbacks: ["google/fallback"],
      subagent: { model: "deepseek/sub" },
      vision: { relay: { relayModel: "google/vision" } },
      build: { models: { cheap: "openrouter/cheap", strong: "zai/strong" } },
    }, {
      modelFallbacks: ["zai/project-fallback"],
    })).toEqual([
      "openai/main",
      "anthropic/plan",
      "deepseek/sub",
      "google/vision",
      "openrouter/cheap",
      "zai/strong",
    ]);
    expect(configuredCloudFallbackModels({ modelFallbacks: ["google/fallback"] }, {
      modelFallbacks: ["zai/project-fallback"],
      memory: { semantic: { enabled: true, model: "openai/embedding" } },
    })).toEqual(["zai/project-fallback", "openai/embedding"]);
  });

  it("lets an explicit key replace local token-file authentication", () => {
    expect(cloudModelEnvironment("codex/gpt-5.3-codex", {
      providers: { codex: { tokenFile: "~/.codex/auth.json" } },
    }, undefined, { VIBE_CODEX_OAUTH_TOKEN: "portable-secret" })).toEqual({
      VIBE_CODEX_OAUTH_TOKEN: "portable-secret",
    });
  });

  it("moves arbitrary custom provider credentials through deterministic environment bindings", () => {
    expect(cloudModelEnvironment("acme-gateway/code", {
      providers: {
        "acme-gateway": {
          apiKey: "acme-secret",
          baseURL: "https://models.acme.example/v1",
          transport: "openai-responses",
          models: ["code"],
          headers: { "x-team": "platform" },
        },
      },
    }, undefined, {})).toEqual({
      VIBE_PROVIDER_ACME_GATEWAY_API_KEY: "acme-secret",
      VIBE_PROVIDER_ACME_GATEWAY_BASE_URL: "https://models.acme.example/v1",
      VIBE_PROVIDER_ACME_GATEWAY_TRANSPORT: "openai-responses",
      VIBE_PROVIDER_ACME_GATEWAY_HEADERS_JSON: JSON.stringify({ "x-team": "platform" }),
    });
  });

  it("blocks local-only model access before a sandbox is created", () => {
    expect(() => cloudModelEnvironment("ollama/gpt-oss:20b", {}, undefined, {}))
      .toThrow("Cloud sandbox cannot reach");
    expect(() => cloudModelEnvironment("lmstudio/local-model", {}, undefined, {}))
      .toThrow("LM Studio runs only on this Mac");
  });
});
