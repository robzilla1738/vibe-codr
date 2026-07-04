import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpTokenStore, createMcpOAuthProvider, legacyMcpTokenStorePath, mcpTokenStorePath } from "./mcp-oauth.ts";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "vibe-mcp-oauth-"));
}

function tmpStore() {
  return new McpTokenStore(join(tmpDir(), "srv.json"));
}

test("McpTokenStore round-trips tokens, client info, and the PKCE verifier", async () => {
  const store = tmpStore();
  expect(await store.read()).toEqual({}); // empty before anything is written
  await store.merge({ tokens: { access_token: "a1", refresh_token: "r1" } });
  await store.merge({ codeVerifier: "verifier-xyz" });
  await store.merge({ clientInformation: { client_id: "c1" } });
  const state = await store.read();
  expect(state.tokens).toEqual({ access_token: "a1", refresh_token: "r1" });
  expect(state.codeVerifier).toBe("verifier-xyz");
  expect(state.clientInformation).toEqual({ client_id: "c1" });
});

test("McpTokenStore.merge is atomic (no leftover temp file) and preserves prior keys", async () => {
  const store = tmpStore();
  await store.merge({ clientInformation: { client_id: "dyn-123" } });
  await store.merge({ tokens: { access_token: "a", refresh_token: "r" } });
  const state = await store.read();
  expect(state.clientInformation).toEqual({ client_id: "dyn-123" }); // preserved across merges
  expect(state.tokens).toEqual({ access_token: "a", refresh_token: "r" });
  // No stray temp file left behind (the write is temp+rename).
  expect(await Bun.file(`${store.path}.tmp`).exists()).toBe(false);
});

test("a corrupt token file is set aside on read, not silently clobbered", async () => {
  const store = tmpStore();
  await store.merge({ clientInformation: { client_id: "dyn-123" }, tokens: { refresh_token: "keep-me" } });
  // Simulate a crash-corrupted file (truncated JSON).
  await Bun.write(store.path, '{"tokens": {"refresh');
  // read() must not return {} while erasing the file — it backs it up instead.
  expect(await store.read()).toEqual({});
  expect(await Bun.file(`${store.path}.corrupt`).exists()).toBe(true);
  // The salvaged bytes are recoverable from the .corrupt sidecar.
  expect(await Bun.file(`${store.path}.corrupt`).text()).toContain("refresh");
});

test("McpTokenStore.clear removes the persisted state", async () => {
  const store = tmpStore();
  await store.merge({ tokens: { access_token: "a" } });
  await store.clear();
  expect(await store.read()).toEqual({});
});

test("mcpTokenStorePath sanitizes the server name and honors an override", () => {
  expect(mcpTokenStorePath("gh/api", undefined)).toMatch(/vibe-codr\/mcp\/gh_api-[0-9a-f]{8}\.json$/);
  expect(mcpTokenStorePath("gh", "/custom/tokens.json")).toBe("/custom/tokens.json");
});

test("servers that sanitize-equal get distinct token stores (no grant mixup)", () => {
  // `gh/api` and `gh_api` both slug to `gh_api`; the bare-slug path collided, so
  // two DISTINCT servers shared one store — one server could read (and clobber)
  // the other's grant. The raw-name hash keeps them apart, deterministically.
  const a = mcpTokenStorePath("gh/api", undefined);
  const b = mcpTokenStorePath("gh_api", undefined);
  expect(a).not.toBe(b);
  expect(mcpTokenStorePath("gh/api", undefined)).toBe(a); // stable across calls
});

test("a grant at the legacy (pre-hash) path migrates on first read — no forced re-auth", async () => {
  const dir = tmpDir();
  const legacy = join(dir, "srv.json");
  const current = join(dir, "srv-0a1b2c3d.json");
  await Bun.write(legacy, JSON.stringify({ tokens: { access_token: "old-grant" } }));
  const store = new McpTokenStore(current, legacy);
  // The pre-fix grant is still readable through the new path…
  expect((await store.read()).tokens).toEqual({ access_token: "old-grant" });
  // …and was MOVED (rename), so it now lives at the current path only.
  expect(await Bun.file(current).exists()).toBe(true);
  expect(await Bun.file(legacy).exists()).toBe(false);
  // Later merges keep everything at the current path.
  await store.merge({ codeVerifier: "v" });
  expect((await store.read()).tokens).toEqual({ access_token: "old-grant" });
  expect(await Bun.file(legacy).exists()).toBe(false);
});

test("an existing current-path store wins over a stale legacy file", async () => {
  // The collision pair's OTHER server may still own the legacy slug — a store
  // that already exists at the current path must never be clobbered by it.
  const dir = tmpDir();
  const legacy = join(dir, "srv.json");
  const current = join(dir, "srv-0a1b2c3d.json");
  await Bun.write(legacy, JSON.stringify({ tokens: { access_token: "other-servers" } }));
  await Bun.write(current, JSON.stringify({ tokens: { access_token: "mine" } }));
  const store = new McpTokenStore(current, legacy);
  expect((await store.read()).tokens).toEqual({ access_token: "mine" });
  expect(await Bun.file(legacy).exists()).toBe(true); // left untouched
});

test("clear drops a not-yet-migrated legacy grant too (revocation can't resurrect)", async () => {
  const dir = tmpDir();
  const legacy = join(dir, "srv.json");
  const store = new McpTokenStore(join(dir, "srv-0a1b2c3d.json"), legacy);
  await Bun.write(legacy, JSON.stringify({ tokens: { access_token: "revoke-me" } }));
  await store.clear();
  expect(await store.read()).toEqual({}); // read would otherwise migrate it back in
  expect(await Bun.file(legacy).exists()).toBe(false);
});

test("legacyMcpTokenStorePath is the bare pre-hash slug", () => {
  expect(legacyMcpTokenStorePath("gh/api")).toMatch(/vibe-codr\/mcp\/gh_api\.json$/);
});

test("provider persists tokens through the store and reflects config in metadata", async () => {
  const store = tmpStore();
  const provider = createMcpOAuthProvider(
    "gh",
    { scopes: ["repo", "read:user"], clientName: "my-cli", redirectUri: "http://localhost:9999/cb" },
    { store },
  );
  expect(provider.redirectUrl).toBe("http://localhost:9999/cb");
  expect(provider.clientMetadata.scope).toBe("repo read:user");
  expect(provider.clientMetadata.client_name).toBe("my-cli");
  expect(provider.clientMetadata.redirect_uris).toEqual(["http://localhost:9999/cb"]);

  expect(await provider.tokens()).toBeUndefined();
  await provider.saveTokens({ access_token: "tok" });
  expect(await provider.tokens()).toEqual({ access_token: "tok" });

  await provider.saveCodeVerifier("v1");
  expect(await provider.codeVerifier()).toBe("v1");
});

test("provider falls back to a configured clientId when nothing is registered yet", async () => {
  const store = tmpStore();
  const provider = createMcpOAuthProvider("gh", { clientId: "preregistered" }, { store });
  expect(await provider.clientInformation()).toEqual({ client_id: "preregistered" });
  // Once dynamic registration saves fuller info, that wins.
  await provider.saveClientInformation({ client_id: "dyn", client_secret: "s" });
  expect(await provider.clientInformation()).toEqual({ client_id: "dyn", client_secret: "s" });
});

test("redirectToAuthorization surfaces the URL via the injected opener", async () => {
  const store = tmpStore();
  let opened = "";
  const provider = createMcpOAuthProvider(
    "gh",
    { scopes: ["repo"] },
    { store, openUrl: (u) => void (opened = u) },
  );
  await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
  expect(opened).toBe("https://auth.example.com/authorize?x=1");
});

test("invalidateCredentials('all') clears the store", async () => {
  const store = tmpStore();
  const provider = createMcpOAuthProvider("gh", {}, { store });
  await provider.saveTokens({ access_token: "a" });
  await provider.invalidateCredentials("all");
  expect(await store.read()).toEqual({});
});
