import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpTokenStore, createMcpOAuthProvider, mcpTokenStorePath } from "./mcp-oauth.ts";

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mcp-oauth-"));
  return new McpTokenStore(join(dir, "srv.json"));
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

test("McpTokenStore.clear removes the persisted state", async () => {
  const store = tmpStore();
  await store.merge({ tokens: { access_token: "a" } });
  await store.clear();
  expect(await store.read()).toEqual({});
});

test("mcpTokenStorePath sanitizes the server name and honors an override", () => {
  expect(mcpTokenStorePath("gh/api", undefined)).toMatch(/vibe-codr\/mcp\/gh_api\.json$/);
  expect(mcpTokenStorePath("gh", "/custom/tokens.json")).toBe("/custom/tokens.json");
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
