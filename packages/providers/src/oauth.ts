import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SubscriptionProviderId = "openai-codex" | "xai-oauth";
export type SubscriptionAuthMethod = "browser" | "device";

export interface SubscriptionAuthStart {
  sessionId: string;
  providerId: SubscriptionProviderId;
  method: SubscriptionAuthMethod;
  url: string;
  userCode?: string;
  expiresAt: number;
}

export interface SubscriptionAuthStatus {
  sessionId?: string;
  providerId: SubscriptionProviderId;
  state: "disconnected" | "pending" | "connected" | "error" | "cancelled";
  method?: SubscriptionAuthMethod;
  url?: string;
  userCode?: string;
  expiresAt?: number;
  accountLabel?: string;
  error?: string;
}

interface StoredOAuthToken {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  accountLabel?: string;
}

interface AuthStore {
  version: 1;
  providers: Partial<Record<SubscriptionProviderId, StoredOAuthToken>>;
}

interface PendingAuth extends SubscriptionAuthStart {
  state: SubscriptionAuthStatus["state"];
  error?: string;
  server?: Server;
  cancelled: boolean;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

export function xaiDevicePollDecision(
  error: unknown,
  intervalMs: number,
): { action: "wait" | "fail"; intervalMs: number; message?: string } {
  if (error === "authorization_pending") return { action: "wait", intervalMs };
  if (error === "slow_down") return { action: "wait", intervalMs: intervalMs + 5000 };
  if (error === "expired_token")
    return { action: "fail", intervalMs, message: "The xAI device code expired." };
  if (error === "access_denied" || error === "authorization_denied") {
    return { action: "fail", intervalMs, message: "xAI authorization was denied." };
  }
  return { action: "fail", intervalMs, message: "xAI device authorization failed." };
}

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_CALLBACK = "http://localhost:1455/auth/callback";
const CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_ISSUER = "https://auth.x.ai/oauth2";
const XAI_CALLBACK = "http://127.0.0.1:56121/callback";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_SKEW_MS = 120_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

function authStorePath(): string {
  return process.env.VIBE_AUTH_PATH || join(homedir(), ".vibe-codr", "auth.json");
}

let storeReadCache:
  | {
      path: string;
      signature: string;
      checkedAt: number;
      store: AuthStore;
    }
  | undefined;

function cloneStore(store: AuthStore): AuthStore {
  return structuredClone(store);
}

async function authStoreSignature(path: string): Promise<string> {
  try {
    const value = await stat(path);
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`;
  } catch {
    return "missing";
  }
}

async function readStore(): Promise<AuthStore> {
  const path = authStorePath();
  const now = Date.now();
  // Stat on every request so an external login/logout is visible immediately;
  // the JSON parse and file read remain cached while the signature is stable.
  const signature = await authStoreSignature(path);
  if (storeReadCache?.path === path && storeReadCache.signature === signature) {
    storeReadCache.checkedAt = now;
    return cloneStore(storeReadCache.store);
  }
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<AuthStore>;
    const store = { version: 1 as const, providers: value.providers ?? {} };
    storeReadCache = { path, signature, checkedAt: now, store: cloneStore(store) };
    return store;
  } catch {
    const store: AuthStore = { version: 1, providers: {} };
    storeReadCache = { path, signature: "missing", checkedAt: now, store: cloneStore(store) };
    return store;
  }
}

async function writeStore(store: AuthStore): Promise<void> {
  const path = authStorePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
  storeReadCache = {
    path,
    signature: await authStoreSignature(path),
    checkedAt: Date.now(),
    store: cloneStore(store),
  };
}

let storeWriteQueue: Promise<void> = Promise.resolve();

async function mutateStore(mutator: (store: AuthStore) => void): Promise<void> {
  const operation = storeWriteQueue.then(async () => {
    const store = await readStore();
    mutator(store);
    await writeStore(store);
  });
  storeWriteQueue = operation.catch(() => {});
  return operation;
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

function jwtClaims(token?: string): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function claimString(claims: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = claims?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function codexIdentity(tokens: TokenResponse): { accountId?: string; accountLabel?: string } {
  const claims = jwtClaims(tokens.id_token) ?? jwtClaims(tokens.access_token);
  const nested = claims?.["https://api.openai.com/auth"];
  const nestedId =
    nested && typeof nested === "object"
      ? claimString(nested as Record<string, unknown>, "chatgpt_account_id")
      : undefined;
  const organizations = Array.isArray(claims?.organizations) ? claims.organizations : [];
  const organizationId =
    organizations.length && organizations[0] && typeof organizations[0] === "object"
      ? claimString(organizations[0] as Record<string, unknown>, "id")
      : undefined;
  return {
    accountId: claimString(claims, "chatgpt_account_id") ?? nestedId ?? organizationId,
    accountLabel: claimString(claims, "email"),
  };
}

function tokenExpiry(tokens: TokenResponse): number {
  const claims = jwtClaims(tokens.access_token);
  const exp = claims?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) return exp * 1000;
  return Date.now() + (tokens.expires_in ?? 3600) * 1000;
}

async function tokenRequest(url: string, body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": "vibe-codr",
    },
    body,
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof json.access_token !== "string") {
    const detail =
      typeof json.error_description === "string"
        ? json.error_description
        : typeof json.error === "string"
          ? json.error
          : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return json as unknown as TokenResponse;
}

async function persistTokens(
  providerId: SubscriptionProviderId,
  tokens: TokenResponse,
  previous?: StoredOAuthToken,
): Promise<void> {
  const identity =
    providerId === "openai-codex"
      ? codexIdentity(tokens)
      : {
          accountLabel: claimString(
            jwtClaims(tokens.id_token) ?? jwtClaims(tokens.access_token),
            "email",
          ),
        };
  await mutateStore((store) => {
    store.providers[providerId] = {
      access: tokens.access_token,
      refresh: tokens.refresh_token || previous?.refresh || "",
      expires: tokenExpiry(tokens),
      accountId: identity.accountId ?? previous?.accountId,
      accountLabel: identity.accountLabel ?? previous?.accountLabel,
    };
  });
}

function successPage(provider: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${provider} connected</title><style>body{font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0}main{max-width:28rem}h1{font-size:1.5rem}</style><main><h1>${provider} connected</h1><p>You can close this tab and return to Vibe Codr.</p></main>`;
}

function errorPage(message: string): string {
  const safe = message.replace(
    /[<>&"]/g,
    (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[char]!,
  );
  return `<!doctype html><meta charset="utf-8"><title>Connection failed</title><body><h1>Connection failed</h1><p>${safe}</p></body>`;
}

export class ProviderAuthManager {
  private pending = new Map<string, PendingAuth>();

  async status(
    providerId: SubscriptionProviderId,
    sessionId?: string,
  ): Promise<SubscriptionAuthStatus> {
    if (sessionId) {
      const pending = this.pending.get(sessionId);
      if (pending && pending.providerId === providerId) {
        return {
          sessionId,
          providerId,
          state: pending.state,
          method: pending.method,
          url: pending.url,
          userCode: pending.userCode,
          expiresAt: pending.expiresAt,
          error: pending.error,
        };
      }
    }
    const token = (await readStore()).providers[providerId];
    return token
      ? { providerId, state: "connected", accountLabel: token.accountLabel }
      : { providerId, state: "disconnected" };
  }

  async begin(
    providerId: SubscriptionProviderId,
    method: SubscriptionAuthMethod,
  ): Promise<SubscriptionAuthStart> {
    if (providerId === "openai-codex" && method === "device") {
      throw new Error("Codex sign-in uses the browser callback flow.");
    }
    return method === "device" ? this.beginXaiDevice() : this.beginBrowser(providerId);
  }

  async cancel(sessionId: string): Promise<void> {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    pending.cancelled = true;
    pending.state = "cancelled";
    pending.server?.close();
    pending.server = undefined;
  }

  async logout(providerId: SubscriptionProviderId): Promise<void> {
    await mutateStore((store) => {
      delete store.providers[providerId];
    });
  }

  /** Main-process-only Cloud binding: returns the current access token and
   * non-secret account routing metadata, never the refresh token. */
  async exportCredential(
    providerId: SubscriptionProviderId,
  ): Promise<{ providerId: SubscriptionProviderId; access: string; accountId?: string } | null> {
    const token = await ensureSubscriptionToken(providerId);
    return token ? { providerId, access: token.access, accountId: token.accountId } : null;
  }

  private async beginBrowser(providerId: SubscriptionProviderId): Promise<SubscriptionAuthStart> {
    const isCodex = providerId === "openai-codex";
    const redirectUri = isCodex ? CODEX_CALLBACK : XAI_CALLBACK;
    const callback = new URL(redirectUri);
    const codes = pkce();
    const state = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(32));
    const sessionId = randomUUID();
    const expiresAt = Date.now() + LOGIN_TIMEOUT_MS;
    const authorize = new URL(
      isCodex ? `${CODEX_ISSUER}/oauth/authorize` : `${XAI_ISSUER}/authorize`,
    );
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: isCodex ? CODEX_CLIENT_ID : XAI_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: isCodex ? CODEX_SCOPE : XAI_SCOPE,
      code_challenge: codes.challenge,
      code_challenge_method: "S256",
      state,
      ...(isCodex
        ? {
            id_token_add_organizations: "true",
            codex_cli_simplified_flow: "true",
            originator: "vibe-codr",
          }
        : { nonce, plan: "generic", referrer: "vibe-codr" }),
    }).toString();
    const server = createServer((request, response) => {
      const url = new URL(request.url || "/", redirectUri);
      if (url.pathname !== callback.pathname) {
        response.writeHead(404).end("Not found");
        return;
      }
      const pending = this.pending.get(sessionId);
      if (!pending || pending.cancelled) {
        response.writeHead(410).end("Login no longer active");
        return;
      }
      const error = url.searchParams.get("error_description") || url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code || url.searchParams.get("state") !== state) {
        const message = error || (!code ? "Missing authorization code" : "Invalid OAuth state");
        pending.state = "error";
        pending.error = message;
        response
          .writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(errorPage(message));
        server.close();
        return;
      }
      void tokenRequest(
        isCodex ? `${CODEX_ISSUER}/oauth/token` : `${XAI_ISSUER}/token`,
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: isCodex ? CODEX_CLIENT_ID : XAI_CLIENT_ID,
          code,
          redirect_uri: redirectUri,
          code_verifier: codes.verifier,
        }),
      )
        .then(async (tokens) => {
          await persistTokens(providerId, tokens);
          pending.state = "connected";
          response
            .writeHead(200, { "content-type": "text/html; charset=utf-8" })
            .end(successPage(isCodex ? "ChatGPT" : "xAI"));
        })
        .catch((cause) => {
          pending.state = "error";
          pending.error = cause instanceof Error ? cause.message : String(cause);
          response
            .writeHead(400, { "content-type": "text/html; charset=utf-8" })
            .end(errorPage(pending.error));
        })
        .finally(() => server.close());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(callback.port), callback.hostname, () => resolve());
    });
    const pending: PendingAuth = {
      sessionId,
      providerId,
      method: "browser",
      url: authorize.toString(),
      expiresAt,
      state: "pending",
      server,
      cancelled: false,
    };
    this.pending.set(sessionId, pending);
    setTimeout(() => {
      if (pending.state === "pending") {
        pending.state = "error";
        pending.error = "Sign-in timed out.";
        pending.server?.close();
      }
    }, LOGIN_TIMEOUT_MS).unref();
    return pending;
  }

  private async beginXaiDevice(): Promise<SubscriptionAuthStart> {
    const response = await fetch(`${XAI_ISSUER}/device/code`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": "vibe-codr",
      },
      body: new URLSearchParams({
        client_id: XAI_CLIENT_ID,
        scope: XAI_SCOPE,
        referrer: "vibe-codr",
      }),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (
      !response.ok ||
      typeof json.device_code !== "string" ||
      typeof json.user_code !== "string"
    ) {
      throw new Error(
        typeof json.error_description === "string"
          ? json.error_description
          : "xAI did not return a device code.",
      );
    }
    const url =
      typeof json.verification_uri_complete === "string"
        ? json.verification_uri_complete
        : typeof json.verification_uri === "string"
          ? json.verification_uri
          : "https://accounts.x.ai";
    const expiresMs =
      Number.isFinite(Number(json.expires_in)) && Number(json.expires_in) > 0
        ? Number(json.expires_in) * 1000
        : LOGIN_TIMEOUT_MS;
    const interval =
      Number.isFinite(Number(json.interval)) && Number(json.interval) > 0
        ? Math.max(1000, Number(json.interval) * 1000)
        : 5000;
    const pending: PendingAuth = {
      sessionId: randomUUID(),
      providerId: "xai-oauth",
      method: "device",
      url,
      userCode: json.user_code,
      expiresAt: Date.now() + expiresMs,
      state: "pending",
      cancelled: false,
    };
    this.pending.set(pending.sessionId, pending);
    void this.pollXaiDevice(pending, json.device_code, interval);
    return pending;
  }

  private async pollXaiDevice(
    pending: PendingAuth,
    deviceCode: string,
    initialInterval: number,
  ): Promise<void> {
    let interval = initialInterval;
    while (!pending.cancelled && Date.now() < pending.expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      if (pending.cancelled) return;
      const response = await fetch(`${XAI_ISSUER}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          "user-agent": "vibe-codr",
        },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          client_id: XAI_CLIENT_ID,
          device_code: deviceCode,
        }),
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok && typeof json.access_token === "string") {
        await persistTokens("xai-oauth", json as unknown as TokenResponse);
        pending.state = "connected";
        return;
      }
      const decision = xaiDevicePollDecision(json.error, interval);
      interval = decision.intervalMs;
      if (decision.action === "wait") continue;
      pending.state = "error";
      pending.error =
        typeof json.error_description === "string" ? json.error_description : decision.message;
      return;
    }
    if (!pending.cancelled && pending.state === "pending") {
      pending.state = "error";
      pending.error = "The xAI device code expired.";
    }
  }
}

const refreshes = new Map<SubscriptionProviderId, Promise<StoredOAuthToken>>();

export async function ensureSubscriptionToken(
  providerId: SubscriptionProviderId,
): Promise<StoredOAuthToken | undefined> {
  const current = (await readStore()).providers[providerId];
  if (!current) return undefined;
  if (current.expires - Date.now() > REFRESH_SKEW_MS) return current;
  const active = refreshes.get(providerId);
  if (active) return active;
  const refresh = (async () => {
    if (!current.refresh) throw new Error(`${providerId} sign-in expired; connect again.`);
    const isCodex = providerId === "openai-codex";
    const tokens = await tokenRequest(
      isCodex ? `${CODEX_ISSUER}/oauth/token` : `${XAI_ISSUER}/token`,
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: isCodex ? CODEX_CLIENT_ID : XAI_CLIENT_ID,
        refresh_token: current.refresh,
      }),
    );
    await persistTokens(providerId, tokens, current);
    return (await readStore()).providers[providerId]!;
  })().finally(() => refreshes.delete(providerId));
  refreshes.set(providerId, refresh);
  return refresh;
}

export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function subscriptionFetch(providerId: SubscriptionProviderId): ProviderFetch {
  return async (input, init) => {
    const token = await ensureSubscriptionToken(providerId);
    if (!token) return fetch(input, init);
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.set("authorization", `Bearer ${token.access}`);
    if (providerId === "openai-codex") {
      if (token.accountId) headers.set("ChatGPT-Account-Id", token.accountId);
      headers.set("originator", "vibe-codr");
    }
    const original = input instanceof Request ? input.url : input.toString();
    const url =
      providerId === "openai-codex" &&
      (/\/responses(?:\?|$)/.test(original) || /\/chat\/completions(?:\?|$)/.test(original))
        ? "https://chatgpt.com/backend-api/codex/responses"
        : input;
    return fetch(url, { ...init, headers });
  };
}

export async function removeAuthStoreForTests(): Promise<void> {
  if (!process.env.VIBE_AUTH_PATH) throw new Error("VIBE_AUTH_PATH is required");
  await rm(process.env.VIBE_AUTH_PATH, { force: true });
  storeReadCache = undefined;
}
