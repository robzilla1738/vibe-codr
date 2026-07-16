import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, defaultConfig } from "@vibe/config";
import { builtinProviders } from "./defs.ts";
import { PROVIDER_MANIFEST } from "./provider-manifest.ts";
import { ProviderRegistry } from "./registry.ts";

function withProvider(id: string, cfg: Record<string, unknown>): Config {
  const base = defaultConfig();
  return { ...base, providers: { ...base.providers, [id]: cfg } } as Config;
}

test("the new providers are registered", () => {
  const reg = new ProviderRegistry();
  for (const id of [
    "minimax",
    "codex",
    "xai",
    "meta",
    "ollama",
    "lmstudio",
    "google",
    "groq",
    "mistral",
    "together",
    "cerebras",
    "perplexity",
    "custom",
  ]) {
    expect(reg.has(id)).toBe(true);
  }
});

test("the registry covers the complete generated models.dev provider manifest", () => {
  const reg = new ProviderRegistry();
  expect(PROVIDER_MANIFEST.length).toBeGreaterThanOrEqual(75);
  for (const provider of PROVIDER_MANIFEST) {
    expect(reg.has(provider.id)).toBe(true);
  }
});

test("catalog-generated providers keep endpoint templates and credential envs", () => {
  const reg = new ProviderRegistry();
  expect(reg.get("novita-ai")?.auth.env).toContain("NOVITA_API_KEY");
  expect(reg.get("github-copilot")?.auth.env).toContain("GITHUB_TOKEN");
  expect(reg.get("alibaba-coding-plan")?.auth.env).toContain("ALIBABA_CODING_PLAN_API_KEY");
  expect(reg.get("xiaomi")?.auth.env).toContain("XIAOMI_API_KEY");
  expect(reg.get("stepfun")?.auth.env).toContain("STEPFUN_API_KEY");
});

test("Hermes-compatible provider ids resolve without translation", () => {
  const reg = new ProviderRegistry();
  for (const id of [
    "nous",
    "openai-api",
    "openai-codex",
    "xai-oauth",
    "copilot",
    "gemini",
    "kimi-coding",
    "kimi-coding-cn",
    "minimax-cn",
    "minimax-oauth",
    "arcee",
    "gmi",
    "kilocode",
    "novita",
    "ollama-cloud",
    "opencode-zen",
    "opencode-go",
    "qwen-oauth",
    "bedrock",
    "vertex",
    "azure-foundry",
  ]) {
    expect(reg.has(id)).toBe(true);
  }
});

test("Codex subscription aliases never mistake a public OpenAI key for ChatGPT auth", () => {
  const reg = new ProviderRegistry();
  const previous = {
    openai: process.env.OPENAI_API_KEY,
    codex: process.env.CODEX_API_KEY,
    oauth: process.env.VIBE_CODEX_OAUTH_TOKEN,
  };
  process.env.OPENAI_API_KEY = "public-openai-key";
  process.env.CODEX_API_KEY = "legacy-codex-key";
  delete process.env.VIBE_CODEX_OAUTH_TOKEN;
  try {
    expect(() => reg.resolveAuth("codex", withProvider("codex", {
      tokenFile: "/definitely/missing/codex-auth.json",
    }))).toThrow(/VIBE_CODEX_OAUTH_TOKEN/);
  } finally {
    if (previous.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.openai;
    if (previous.codex === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previous.codex;
    if (previous.oauth === undefined) delete process.env.VIBE_CODEX_OAUTH_TOKEN;
    else process.env.VIBE_CODEX_OAUTH_TOKEN = previous.oauth;
  }
});

test("Codex CLI OAuth supplies its access token and ChatGPT account routing header", async () => {
  const reg = new ProviderRegistry();
  const path = join(mkdtempSync(join(tmpdir(), "vibe-codex-auth-")), "auth.json");
  await Bun.write(path, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "oauth-access", account_id: "account-123" },
  }));
  const auth = reg.resolveAuth("codex", withProvider("codex", { tokenFile: path }));
  expect(auth.apiKey).toBe("oauth-access");
  expect(auth.headers?.["ChatGPT-Account-Id"]).toBe("account-123");
});

test("xAI routes only Grok 4.5 through Responses", async () => {
  for (const id of ["xai", "xai-oauth"]) {
    const def = builtinProviders().find((provider) => provider.id === id);
    if (!def) throw new Error(`${id} provider missing`);
    const grok45 = await def.create("grok-4.5", { apiKey: "test-token" }) as { provider?: string };
    const grokBuild = await def.create("grok-build-0.1", { apiKey: "test-token" }) as { provider?: string };
    expect(grok45.provider).toBe(`${id}.responses`);
    expect(grokBuild.provider).toBe(`${id}.chat`);
  }
});

test("xAI subscription catalog always exposes Grok 4.5 and Grok Build", async () => {
  const def = builtinProviders().find((provider) => provider.id === "xai-oauth");
  if (!def) throw new Error("xai-oauth provider missing");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  try {
    expect((await def.listModels({ apiKey: "test-token" })).map((model) => model.id))
      .toEqual(["grok-4.5", "grok-build-0.1"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("native cloud providers construct the AI SDK model family they require", async () => {
  const previous = {
    project: process.env.GOOGLE_VERTEX_PROJECT,
    location: process.env.GOOGLE_VERTEX_LOCATION,
  };
  process.env.GOOGLE_VERTEX_PROJECT = "test-project";
  process.env.GOOGLE_VERTEX_LOCATION = "us-central1";
  try {
    const providers = builtinProviders();
    const bedrock = (await providers
      .find((provider) => provider.id === "bedrock")!
      .create("us.anthropic.claude-sonnet-4-6", {})) as { specificationVersion?: string };
    const vertex = (await providers
      .find((provider) => provider.id === "vertex")!
      .create("gemini-3.1-pro-preview", {})) as { specificationVersion?: string };
    const azure = (await providers
      .find((provider) => provider.id === "azure")!
      .create("gpt-5.4", {
        apiKey: "test",
        baseURL: "https://example.openai.azure.com/openai",
      })) as { specificationVersion?: string };
    expect(bedrock.specificationVersion).toBe("v1");
    expect(vertex.specificationVersion).toBe("v2");
    expect(azure.specificationVersion).toBe("v2");
  } finally {
    if (previous.project === undefined) delete process.env.GOOGLE_VERTEX_PROJECT;
    else process.env.GOOGLE_VERTEX_PROJECT = previous.project;
    if (previous.location === undefined) delete process.env.GOOGLE_VERTEX_LOCATION;
    else process.env.GOOGLE_VERTEX_LOCATION = previous.location;
  }
});

test("keyless local providers (ollama, lmstudio) are configured without a key", () => {
  const reg = new ProviderRegistry();
  expect(reg.isConfigured("ollama", defaultConfig())).toBe(true);
  expect(reg.isConfigured("lmstudio", defaultConfig())).toBe(true);
});

test("custom keyless provider still requires a base URL to be configured", () => {
  const reg = new ProviderRegistry();
  const prev = process.env.CUSTOM_BASE_URL;
  delete process.env.CUSTOM_BASE_URL;
  try {
    expect(reg.isConfigured("custom", defaultConfig())).toBe(false);
    expect(
      reg.isConfigured(
        "custom",
        withProvider("custom", { baseURL: "https://endpoint.example.com/v1" }),
      ),
    ).toBe(true);
    process.env.CUSTOM_BASE_URL = "https://env-endpoint.example.com/v1";
    expect(reg.isConfigured("custom", defaultConfig())).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.CUSTOM_BASE_URL;
    else process.env.CUSTOM_BASE_URL = prev;
  }
});

test("snowflake-cortex and cloudflare-workers-ai require both key and base URL", () => {
  const reg = new ProviderRegistry();
  const prev = {
    snowflakeToken: process.env.SNOWFLAKE_CORTEX_TOKEN,
    snowflakePat: process.env.SNOWFLAKE_CORTEX_PAT,
    snowflakeBase: process.env.SNOWFLAKE_CORTEX_BASE_URL,
    cfKey: process.env.CLOUDFLARE_API_KEY,
    cfBase: process.env.CLOUDFLARE_BASE_URL,
  };
  delete process.env.SNOWFLAKE_CORTEX_TOKEN;
  delete process.env.SNOWFLAKE_CORTEX_PAT;
  delete process.env.SNOWFLAKE_CORTEX_BASE_URL;
  delete process.env.CLOUDFLARE_API_KEY;
  delete process.env.CLOUDFLARE_BASE_URL;
  try {
    // Neither key nor base URL → not configured.
    expect(reg.isConfigured("snowflake-cortex", defaultConfig())).toBe(false);
    expect(reg.isConfigured("cloudflare-workers-ai", defaultConfig())).toBe(false);
    // Key only (no base URL) → still not configured (requiresBaseURL).
    process.env.SNOWFLAKE_CORTEX_TOKEN = "sf-token";
    expect(reg.isConfigured("snowflake-cortex", defaultConfig())).toBe(false);
    // Key + base URL → configured.
    process.env.SNOWFLAKE_CORTEX_BASE_URL = "https://acct.snowflakecomputing.com/api/v2/cortex/v1";
    expect(reg.isConfigured("snowflake-cortex", defaultConfig())).toBe(true);
    process.env.SNOWFLAKE_API_KEY = "";
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else (process.env as Record<string, string>)[k] = v;
    }
  }
});

test("ollama stays keyless for local use but accepts a cloud key", () => {
  const reg = new ProviderRegistry();
  // Local: no key needed, no apiKey resolved.
  expect(reg.resolveAuth("ollama", defaultConfig()).apiKey).toBeUndefined();
  // Cloud: a configured key flows through for ollama.com auth.
  const auth = reg.resolveAuth("ollama", withProvider("ollama", { apiKey: "ol-key" }));
  expect(auth.apiKey).toBe("ol-key");
});

test("OLLAMA_API_KEY env enables Ollama Cloud auth", () => {
  const reg = new ProviderRegistry();
  const prev = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "ol-env-key";
  try {
    expect(reg.resolveAuth("ollama", defaultConfig()).apiKey).toBe("ol-env-key");
  } finally {
    if (prev === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = prev;
  }
});

test("config apiKey is used when no env var is set", () => {
  const reg = new ProviderRegistry();
  const auth = reg.resolveAuth("minimax", withProvider("minimax", { apiKey: "mm-key" }));
  expect(auth.apiKey).toBe("mm-key");
});

test("env var takes precedence over config apiKey", () => {
  const reg = new ProviderRegistry();
  const prev = process.env.MINIMAX_API_KEY;
  process.env.MINIMAX_API_KEY = "from-env";
  try {
    const auth = reg.resolveAuth("minimax", withProvider("minimax", { apiKey: "from-config" }));
    expect(auth.apiKey).toBe("from-env");
  } finally {
    if (prev === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = prev;
  }
});

test("a token file supplies the credential and marks the provider configured", async () => {
  const reg = new ProviderRegistry();
  const path = join(mkdtempSync(join(tmpdir(), "vibe-reg-")), "auth.json");
  await Bun.write(path, JSON.stringify({ tokens: { access_token: "oauth-token-xyz" } }));
  const config = withProvider("codex", { tokenFile: path });

  // The dedicated Cloud OAuth binding wins over token files, so clear it to
  // prove the configured file is the credential source.
  const prev = process.env.VIBE_CODEX_OAUTH_TOKEN;
  delete process.env.VIBE_CODEX_OAUTH_TOKEN;
  try {
    expect(reg.isConfigured("codex", config)).toBe(true);
    expect(reg.resolveAuth("codex", config).apiKey).toBe("oauth-token-xyz");
  } finally {
    if (prev === undefined) delete process.env.VIBE_CODEX_OAUTH_TOKEN;
    else process.env.VIBE_CODEX_OAUTH_TOKEN = prev;
  }
});

test("custom headers flow through resolveAuth", () => {
  const reg = new ProviderRegistry();
  const config = withProvider("codex", {
    apiKey: "k",
    headers: { "chatgpt-account-id": "acct_1" },
  });
  expect(reg.resolveAuth("codex", config).headers).toEqual({ "chatgpt-account-id": "acct_1" });
});

test("cloud environment restores an arbitrary provider without a local config file", async () => {
  const names = {
    key: "VIBE_PROVIDER_ACME_GATEWAY_API_KEY",
    base: "VIBE_PROVIDER_ACME_GATEWAY_BASE_URL",
    transport: "VIBE_PROVIDER_ACME_GATEWAY_TRANSPORT",
    headers: "VIBE_PROVIDER_ACME_GATEWAY_HEADERS_JSON",
  } as const;
  const previous = Object.fromEntries(
    Object.entries(names).map(([key, name]) => [key, process.env[name]]),
  );
  process.env[names.key] = "cloud-key";
  process.env[names.base] = "https://models.acme.example/v1";
  process.env[names.transport] = "openai-responses";
  process.env[names.headers] = JSON.stringify({ "x-team": "platform" });
  try {
    const registry = new ProviderRegistry();
    expect(registry.isConfigured("acme-gateway", defaultConfig())).toBe(true);
    expect(registry.resolveAuth("acme-gateway", defaultConfig())).toEqual({
      apiKey: "cloud-key",
      headers: { "x-team": "platform" },
    });
    await expect(
      registry.resolveModel("acme-gateway/code", defaultConfig()),
    ).resolves.toBeDefined();
  } finally {
    for (const [key, name] of Object.entries(names)) {
      const value = previous[key];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("ollama hits the cloud endpoint with a key and localhost without one", async () => {
  const ollama = builtinProviders().find((d) => d.id === "ollama");
  if (!ollama) throw new Error("ollama provider missing");

  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  // A base-URL override would win over the cloud switch — clear it for the test.
  const prevBase = process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_BASE_URL;
  try {
    await ollama.listModels({}); // keyless local
    await ollama.listModels({ apiKey: "ol-cloud-key" }); // subscription
  } finally {
    globalThis.fetch = realFetch;
    if (prevBase === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = prevBase;
  }

  expect(calls[0]).toBe("http://localhost:11434/v1/models");
  expect(calls[1]).toBe("https://ollama.com/v1/models");
});

test("openai-compatible-routed providers create ai@5 (spec v2) models", async () => {
  // baseten/xai/openrouter/fireworks are OpenAI-compatible endpoints driven
  // through @ai-sdk/openai-compatible. Their dedicated packages moved to spec v3+
  // (AI SDK v6) and would be rejected by ai@5 ("unsupported model version"), so
  // this locks in that each still produces a spec-"v2" model.
  for (const id of [
    "baseten",
    "xai",
    "openrouter",
    "fireworks",
    "minimax",
    "google",
    "groq",
    "mistral",
    "together",
    "cerebras",
    "perplexity",
    "zai",
    "moonshot",
    "alibaba",
    "huggingface",
    "meta",
    "nvidia",
    "deepinfra",
    "venice",
    "cohere",
    "kilo",
    "llmgateway",
    "zenmux",
    "snowflake-cortex",
    "cloudflare-workers-ai",
  ]) {
    const def = builtinProviders().find((d) => d.id === id);
    if (!def) throw new Error(`${id} provider missing`);
    // Providers with requiresBaseURL (snowflake-cortex, cloudflare-workers-ai)
    // need a base URL to build a model — pass one so the spec check works.
    const opts = def.auth.requiresBaseURL
      ? { apiKey: "test-key", baseURL: "https://test.example.com/v1" }
      : { apiKey: "test-key" };
    const model = (await def.create("some-model", opts)) as {
      specificationVersion?: string;
    };
    expect(model.specificationVersion).toBe("v2");
  }
});

test("the generic `custom` provider requires a base URL but works once given one", async () => {
  const custom = builtinProviders().find((d) => d.id === "custom");
  if (!custom) throw new Error("custom provider missing");
  // No base URL anywhere → a clear, actionable error (not a broken relative URL).
  const prev = process.env.CUSTOM_BASE_URL;
  delete process.env.CUSTOM_BASE_URL;
  try {
    await expect(custom.create("m", { apiKey: "k" })).rejects.toMatchObject({
      name: "VibeError",
      code: "PROVIDER_CONFIG",
      message: expect.stringMatching(/base URL/i),
    });
    // listing degrades gracefully (no endpoint yet → empty, never throws).
    expect(await custom.listModels({ apiKey: "k" })).toEqual([]);
    // With a base URL it builds a normal spec-v2 model.
    const model = (await custom.create("m", {
      apiKey: "k",
      baseURL: "https://my-endpoint.example.com/v1",
    })) as { specificationVersion?: string };
    expect(model.specificationVersion).toBe("v2");
  } finally {
    if (prev === undefined) delete process.env.CUSTOM_BASE_URL;
    else process.env.CUSTOM_BASE_URL = prev;
  }
});

test("arbitrary config provider ids use Chat Completions and explicit models", async () => {
  const reg = new ProviderRegistry();
  const config = withProvider("acme-gateway", {
    baseURL: "https://models.acme.test/v1",
    apiKey: "secret",
    models: ["acme-code", "acme-fast"],
  });
  expect(reg.list(config).some((provider) => provider.id === "acme-gateway")).toBe(true);
  expect(reg.isConfigured("acme-gateway", config)).toBe(true);
  const model = (await reg.resolveModel("acme-gateway/acme-code", config)) as {
    specificationVersion?: string;
  };
  expect(model.specificationVersion).toBe("v2");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("not found", { status: 404 })) as unknown as typeof fetch;
  try {
    const listed = await reg.listConfiguredModels(config);
    expect(
      listed.filter((entry) => entry.providerId === "acme-gateway").map((entry) => entry.id),
    ).toEqual(["acme-code", "acme-fast"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("arbitrary config provider ids can select the OpenAI Responses transport", async () => {
  const reg = new ProviderRegistry();
  const config = withProvider("responses-gateway", {
    baseURL: "https://responses.acme.test/v1",
    apiKey: "secret",
    transport: "openai-responses",
  });
  const model = (await reg.resolveModel("responses-gateway/codex-like", config)) as {
    specificationVersion?: string;
    provider?: string;
  };
  expect(model.specificationVersion).toBe("v2");
  expect(model.provider).toContain("responses-gateway");
});

test("listModels forwards custom headers to the /models probe", async () => {
  const def = builtinProviders().find((d) => d.id === "openrouter");
  if (!def) throw new Error("openrouter provider missing");
  let seen: Headers | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await def.listModels({ apiKey: "k", headers: { "x-account": "acct_1" } });
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(seen?.get("x-account")).toBe("acct_1");
  expect(seen?.get("authorization")).toBe("Bearer k");
});

test("an unconfigured non-keyless provider is not configured", () => {
  const reg = new ProviderRegistry();
  const prev = process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_API_KEY;
  try {
    expect(reg.isConfigured("minimax", defaultConfig())).toBe(false);
  } finally {
    if (prev !== undefined) process.env.MINIMAX_API_KEY = prev;
  }
});
