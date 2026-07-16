import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  McpTokenStore,
  createMcpOAuthProvider,
  extractOAuthCallbackParams,
  legacyMcpTokenStorePath,
  mcpTokenStorePath,
  waitForOAuthCallback,
} from "./mcp-oauth.ts";

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
  expect(readdirSync(dirname(store.path)).some((f) => f.includes(".tmp"))).toBe(false);
});

test("McpTokenStore.merge serializes concurrent read-merge-writes", async () => {
  const store = tmpStore();
  await Promise.all([
    store.merge({ clientInformation: { client_id: "dyn-123" } }),
    store.merge({ tokens: { access_token: "a", refresh_token: "r" } }),
    store.merge({ codeVerifier: "verifier-xyz" }),
  ]);
  const state = await store.read();
  expect(state.clientInformation).toEqual({ client_id: "dyn-123" });
  expect(state.tokens).toEqual({ access_token: "a", refresh_token: "r" });
  expect(state.codeVerifier).toBe("verifier-xyz");
  expect(readdirSync(dirname(store.path)).some((f) => f.includes(".tmp"))).toBe(false);
});

test("a corrupt token file is set aside on read, not silently clobbered", async () => {
  const store = tmpStore();
  await store.merge({
    clientInformation: { client_id: "dyn-123" },
    tokens: { refresh_token: "keep-me" },
  });
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
  expect(mcpTokenStorePath("gh/api", undefined)).toMatch(
    /vibe-codr\/mcp\/gh_api-[0-9a-f]{8}\.json$/,
  );
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
    {
      scopes: ["repo", "read:user"],
      clientName: "my-cli",
      redirectUri: "http://localhost:9999/cb",
    },
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

test("extractOAuthCallbackParams parses code and error from the redirect URL", () => {
  expect(extractOAuthCallbackParams("/callback?code=abc123")).toEqual({ code: "abc123" });
  expect(extractOAuthCallbackParams("http://localhost:8976/callback?error=access_denied")).toEqual({
    error: "access_denied",
  });
  expect(extractOAuthCallbackParams("/callback?code=abc123&state=s1")).toEqual({
    code: "abc123",
    state: "s1",
  });
  expect(extractOAuthCallbackParams("/callback")).toEqual({});
  expect(extractOAuthCallbackParams("not a url ::::")).toEqual({});
});

test("waitForOAuthCallback resolves the code from a loopback hit", async () => {
  const redirect = "http://127.0.0.1:8977/callback";
  const pending = waitForOAuthCallback(redirect, 5_000);
  // Drive the callback with a local fetch (simulates the browser redirect).
  await fetch(`${redirect}?code=xyz789`).catch(() => {});
  await expect(pending).resolves.toBe("xyz789");
});

test("waitForOAuthCallback multiplexes concurrent flows on one redirect URL by state", async () => {
  const redirect = "http://127.0.0.1:8980/callback";
  const p1 = createMcpOAuthProvider(
    "one",
    { redirectUri: redirect },
    { store: tmpStore(), openUrl: () => {} },
  );
  const p2 = createMcpOAuthProvider(
    "two",
    { redirectUri: redirect },
    { store: tmpStore(), openUrl: () => {} },
  );
  await p1.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=state-one"));
  await p2.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=state-two"));
  const waitOne = waitForOAuthCallback(redirect, 5_000);
  const waitTwo = waitForOAuthCallback(redirect, 5_000);

  // Reverse arrival order: each promise must receive the code matching its own
  // authorization state, not whichever callback hits the shared listener first.
  await fetch(`${redirect}?code=code-two&state=state-two`).catch(() => {});
  await fetch(`${redirect}?code=code-one&state=state-one`).catch(() => {});
  await expect(waitOne).resolves.toBe("code-one");
  await expect(waitTwo).resolves.toBe("code-two");
});

test("waitForOAuthCallback rejects on an error param", async () => {
  const redirect = "http://127.0.0.1:8978/callback";
  const pending = waitForOAuthCallback(redirect, 5_000);
  pending.catch(() => {}); // pre-attach so the rejection during fetch isn't "unhandled"
  await fetch(`${redirect}?error=access_denied`).catch(() => {});
  await expect(pending).rejects.toThrow(/access_denied/);
});

test("waitForOAuthCallback rejects on timeout", async () => {
  const redirect = "http://127.0.0.1:8979/callback";
  await expect(waitForOAuthCallback(redirect, 100)).rejects.toThrow(/timed out/);
});
