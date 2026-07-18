import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSubscriptionToken,
  ProviderAuthManager,
  subscriptionFetch,
  xaiDevicePollDecision,
} from "./oauth.ts";

const originalFetch = globalThis.fetch;
const originalPath = process.env.VIBE_AUTH_PATH;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalPath === undefined) delete process.env.VIBE_AUTH_PATH;
  else process.env.VIBE_AUTH_PATH = originalPath;
});

function unsignedJwt(claims: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

test("Codex browser OAuth verifies callback state, persists 0600 tokens, and reports connected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibe-auth-"));
  process.env.VIBE_AUTH_PATH = join(dir, "auth.json");
  const access = unsignedJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "dev@example.com",
    chatgpt_account_id: "acct_1",
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    expect(input.toString()).toBe("https://auth.openai.com/oauth/token");
    return new Response(
      JSON.stringify({ access_token: access, refresh_token: "refresh-1", expires_in: 3600 }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;
  const manager = new ProviderAuthManager();
  const start = await manager.begin("openai-codex", "browser");
  const authorize = new URL(start.url);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("originator")).toBe("vibe-codr");
  await new Promise<void>((resolve, reject) => {
    get(
      `http://localhost:1455/auth/callback?code=ok&state=${authorize.searchParams.get("state")}`,
      (response) => {
        response.resume();
        response.on("end", resolve);
      },
    ).on("error", reject);
  });
  const status = await manager.status("openai-codex", start.sessionId);
  expect(status.state).toBe("connected");
  const store = JSON.parse(await readFile(process.env.VIBE_AUTH_PATH, "utf8"));
  expect(store.providers["openai-codex"]).toMatchObject({
    access,
    refresh: "refresh-1",
    accountId: "acct_1",
  });
  expect((await stat(process.env.VIBE_AUTH_PATH)).mode & 0o777).toBe(0o600);
});

test("subscription fetch replaces bearer auth and adds the Codex account header", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibe-auth-"));
  process.env.VIBE_AUTH_PATH = join(dir, "auth.json");
  const manager = new ProviderAuthManager();
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        access_token: unsignedJwt({
          exp: Math.floor(Date.now() / 1000) + 3600,
          chatgpt_account_id: "acct_2",
        }),
        refresh_token: "refresh-2",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  const start = await manager.begin("openai-codex", "browser");
  const authorize = new URL(start.url);
  await new Promise<void>((resolve, reject) => {
    get(
      `http://localhost:1455/auth/callback?code=ok&state=${authorize.searchParams.get("state")}`,
      (response) => {
        response.resume();
        response.on("end", resolve);
      },
    ).on("error", reject);
  });
  let requestUrl = "";
  let requestHeaders = new Headers();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = input.toString();
    requestHeaders = new Headers(init?.headers);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await subscriptionFetch("openai-codex")("https://api.openai.com/v1/responses", {
    headers: { authorization: "Bearer dummy" },
  });
  expect(requestUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(requestHeaders.get("authorization")).toMatch(/^Bearer /);
  expect(requestHeaders.get("chatgpt-account-id")).toBe("acct_2");
  expect(requestHeaders.get("originator")).toBe("vibe-codr");
  await manager.logout("openai-codex");
  expect((await manager.status("openai-codex")).state).toBe("disconnected");
});

test("xAI device polling follows pending, slow-down, expiry, and denial semantics", () => {
  expect(xaiDevicePollDecision("authorization_pending", 5000)).toEqual({
    action: "wait",
    intervalMs: 5000,
  });
  expect(xaiDevicePollDecision("slow_down", 5000)).toEqual({ action: "wait", intervalMs: 10_000 });
  expect(xaiDevicePollDecision("expired_token", 5000)).toMatchObject({
    action: "fail",
    message: expect.stringContaining("expired"),
  });
  expect(xaiDevicePollDecision("access_denied", 5000)).toMatchObject({
    action: "fail",
    message: expect.stringContaining("denied"),
  });
});

test("xAI browser OAuth includes the registered desktop flow parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibe-auth-"));
  process.env.VIBE_AUTH_PATH = join(dir, "auth.json");
  const manager = new ProviderAuthManager();
  const start = await manager.begin("xai-oauth", "browser");
  const authorize = new URL(start.url);
  expect(authorize.origin + authorize.pathname).toBe("https://auth.x.ai/oauth2/authorize");
  expect(authorize.searchParams.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
  expect(authorize.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("nonce")).toBeTruthy();
  expect(authorize.searchParams.get("plan")).toBe("generic");
  expect(authorize.searchParams.get("referrer")).toBe("vibe-codr");
  await manager.cancel(start.sessionId);
});

test("xAI refresh rotates the refresh token in the user-only store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibe-auth-"));
  process.env.VIBE_AUTH_PATH = join(dir, "auth.json");
  await mkdir(dir, { recursive: true });
  await writeFile(
    process.env.VIBE_AUTH_PATH,
    JSON.stringify({
      version: 1,
      providers: { "xai-oauth": { access: "old-access", refresh: "old-refresh", expires: 1 } },
    }),
    { mode: 0o600 },
  );
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(input.toString()).toBe("https://auth.x.ai/oauth2/token");
    expect(String(init?.body)).toContain("refresh_token=old-refresh");
    return new Response(
      JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  expect(await ensureSubscriptionToken("xai-oauth")).toMatchObject({
    access: "new-access",
    refresh: "new-refresh",
  });
  const stored = JSON.parse(await readFile(process.env.VIBE_AUTH_PATH, "utf8"));
  expect(stored.providers["xai-oauth"]).toMatchObject({
    access: "new-access",
    refresh: "new-refresh",
  });
});

test("OAuth reads stay cached but external token-file changes invalidate immediately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibe-auth-"));
  process.env.VIBE_AUTH_PATH = join(dir, "auth.json");
  const expires = Date.now() + 3_600_000;
  await writeFile(
    process.env.VIBE_AUTH_PATH,
    JSON.stringify({
      version: 1,
      providers: { "xai-oauth": { access: "first", refresh: "refresh", expires } },
    }),
  );
  expect((await ensureSubscriptionToken("xai-oauth"))?.access).toBe("first");
  await writeFile(
    process.env.VIBE_AUTH_PATH,
    JSON.stringify({
      version: 1,
      providers: { "xai-oauth": { access: "externally-rotated", refresh: "refresh", expires } },
    }),
  );
  expect((await ensureSubscriptionToken("xai-oauth"))?.access).toBe("externally-rotated");
});

test("concurrent expired-token requests coalesce one refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibe-auth-"));
  process.env.VIBE_AUTH_PATH = join(dir, "auth.json");
  await writeFile(
    process.env.VIBE_AUTH_PATH,
    JSON.stringify({
      version: 1,
      providers: { "xai-oauth": { access: "old", refresh: "refresh", expires: 1 } },
    }),
  );
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const values = await Promise.all([
    ensureSubscriptionToken("xai-oauth"),
    ensureSubscriptionToken("xai-oauth"),
    ensureSubscriptionToken("xai-oauth"),
  ]);
  expect(requests).toBe(1);
  expect(values.map((value) => value?.access)).toEqual(["new", "new", "new"]);
});
