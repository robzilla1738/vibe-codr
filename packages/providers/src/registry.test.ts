import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type Config } from "@vibe/config";
import { ProviderRegistry } from "./registry.ts";
import { builtinProviders } from "./defs.ts";

function withProvider(id: string, cfg: Record<string, unknown>): Config {
  const base = defaultConfig();
  return { ...base, providers: { ...base.providers, [id]: cfg } } as Config;
}

test("the new providers are registered", () => {
  const reg = new ProviderRegistry();
  for (const id of [
    "minimax", "codex", "xai", "ollama", "lmstudio",
    "google", "groq", "mistral", "together", "cerebras", "perplexity", "custom",
  ]) {
    expect(reg.has(id)).toBe(true);
  }
});

test("keyless local providers (ollama, lmstudio) are configured without a key", () => {
  const reg = new ProviderRegistry();
  expect(reg.isConfigured("ollama", defaultConfig())).toBe(true);
  expect(reg.isConfigured("lmstudio", defaultConfig())).toBe(true);
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

  // codex resolves env (CODEX_API_KEY, OPENAI_API_KEY) before the tokenFile, so
  // clear both for this test — otherwise a real key in the dev shell wins.
  const prev = { codex: process.env.CODEX_API_KEY, openai: process.env.OPENAI_API_KEY };
  delete process.env.CODEX_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    expect(reg.isConfigured("codex", config)).toBe(true);
    expect(reg.resolveAuth("codex", config).apiKey).toBe("oauth-token-xyz");
  } finally {
    if (prev.codex === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = prev.codex;
    if (prev.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev.openai;
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
    "baseten", "xai", "openrouter", "fireworks", "minimax",
    "google", "groq", "mistral", "together", "cerebras", "perplexity",
    "zai", "moonshot", "alibaba", "huggingface",
  ]) {
    const def = builtinProviders().find((d) => d.id === id);
    if (!def) throw new Error(`${id} provider missing`);
    const model = (await def.create("some-model", { apiKey: "test-key" })) as {
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
    await expect(custom.create("m", { apiKey: "k" })).rejects.toThrow(/base URL/i);
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
