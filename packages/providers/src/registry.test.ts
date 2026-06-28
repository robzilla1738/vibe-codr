import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type Config } from "@vibe/config";
import { ProviderRegistry } from "./registry.ts";

function withProvider(id: string, cfg: Record<string, unknown>): Config {
  const base = defaultConfig();
  return { ...base, providers: { ...base.providers, [id]: cfg } } as Config;
}

test("the new providers are registered", () => {
  const reg = new ProviderRegistry();
  expect(reg.has("minimax")).toBe(true);
  expect(reg.has("codex")).toBe(true);
  expect(reg.has("xai")).toBe(true);
  expect(reg.has("ollama")).toBe(true);
  expect(reg.has("lmstudio")).toBe(true);
});

test("keyless local providers (ollama, lmstudio) are configured without a key", () => {
  const reg = new ProviderRegistry();
  expect(reg.isConfigured("ollama", defaultConfig())).toBe(true);
  expect(reg.isConfigured("lmstudio", defaultConfig())).toBe(true);
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

  expect(reg.isConfigured("codex", config)).toBe(true);
  expect(reg.resolveAuth("codex", config).apiKey).toBe("oauth-token-xyz");
});

test("custom headers flow through resolveAuth", () => {
  const reg = new ProviderRegistry();
  const config = withProvider("codex", {
    apiKey: "k",
    headers: { "chatgpt-account-id": "acct_1" },
  });
  expect(reg.resolveAuth("codex", config).headers).toEqual({ "chatgpt-account-id": "acct_1" });
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
