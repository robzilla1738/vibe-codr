import { join, dirname } from "node:path";
import { mkdir, unlink, rename } from "node:fs/promises";
import { createLogger, type Logger } from "@vibe/shared";
import type { McpOAuth } from "@vibe/config";
import { vibeConfigDir } from "./memory.ts";

/**
 * OAuth 2.1 for remote MCP servers. The interactive authorization-code + PKCE
 * flow is driven by the official SDK's `auth()` machinery; this module supplies
 * the SDK an `OAuthClientProvider` whose durable state (tokens, dynamically
 * registered client info, PKCE verifier) is persisted to a local JSON file so a
 * session's grant survives restarts and refreshes transparently.
 *
 * The persistence layer here is fully self-contained and unit-tested; the SDK
 * itself remains an optional peer dep (the provider object is passed structurally
 * into the transport options).
 */

/** Persisted OAuth state for one server. Shapes mirror the SDK's opaque types. */
export interface StoredMcpAuth {
  tokens?: unknown;
  clientInformation?: unknown;
  codeVerifier?: string;
}

let tokenWriteSeq = 0;

/** Resolve where a server's OAuth state lives (honoring an explicit override).
 * The sanitized name alone can collide (`gh/api` and `gh_api` both slug to
 * `gh_api`), which would hand one server's grant — tokens included — to a
 * DIFFERENT server. A short hash of the RAW name disambiguates (same fix as the
 * report-path sanitize collision). */
export function mcpTokenStorePath(server: string, override?: string): string {
  if (override) return override.startsWith("~") ? join(homeDir(), override.slice(1)) : override;
  return join(vibeConfigDir(), "mcp", `${sanitizeServer(server)}-${shortHash(server)}.json`);
}

/** Pre-hash on-disk location (bare slug). Kept as a read/migration fallback so
 * an existing grant isn't orphaned by the path change — see McpTokenStore. */
export function legacyMcpTokenStorePath(server: string): string {
  return join(vibeConfigDir(), "mcp", `${sanitizeServer(server)}.json`);
}

function sanitizeServer(server: string): string {
  return server.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** Deterministic 8-char hex hash of a string (FNV-1a). Dependency-free and
 * stable across runs, so every session derives the same store path. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || ".";
}

/** A tiny JSON-file store for one server's OAuth state (atomic-ish overwrite).
 * When a `legacyPath` is given (the pre-hash bare-slug location), an existing
 * grant there is migrated on first read — renamed to the new path — so the
 * path-collision fix doesn't force a re-auth of every already-granted server. */
export class McpTokenStore {
  #path: string;
  #legacyPath: string | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string, legacyPath?: string) {
    this.#path = path;
    this.#legacyPath = legacyPath;
  }

  get path(): string {
    return this.#path;
  }

  /** One-shot migration: a grant persisted at the legacy (pre-hash) path moves
   * to the current path when the current one doesn't exist yet. Rename is
   * atomic, and the moved file then flows through the normal read (including
   * corrupt-file set-aside) exactly like a natively-written one. Best-effort —
   * a failed rename just means the grant re-auths, never a broken store. */
  async #migrateLegacy(): Promise<void> {
    if (!this.#legacyPath || this.#legacyPath === this.#path) return;
    if (await Bun.file(this.#path).exists()) return;
    if (!(await Bun.file(this.#legacyPath).exists())) return;
    await rename(this.#legacyPath, this.#path).catch(() => undefined);
  }

  async read(): Promise<StoredMcpAuth> {
    await this.#migrateLegacy();
    const file = Bun.file(this.#path);
    if (!(await file.exists())) return {}; // absent → genuinely empty store
    try {
      return JSON.parse(await file.text()) as StoredMcpAuth;
    } catch {
      // Present but unparseable: do NOT silently treat as empty — the next merge()
      // would then persist only the new patch and drop the (recoverable) tokens +
      // dynamic client registration. Set the corrupt file aside so a merge starts
      // clean without erasing it without a trace.
      await rename(this.#path, `${this.#path}.corrupt`).catch(() => undefined);
      return {};
    }
  }

  /** Merge `patch` into the stored state (create parent dir as needed). Atomic:
   * writes a temp file then renames over the target, so a crash mid-write leaves
   * the previous good file intact instead of a truncated one that reads as empty
   * (which would drop the whole grant on the next merge). */
  async merge(patch: Partial<StoredMcpAuth>): Promise<void> {
    const next = this.#chain.then(
      () => this.#mergeLocked(patch),
      () => this.#mergeLocked(patch),
    );
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #mergeLocked(patch: Partial<StoredMcpAuth>): Promise<void> {
    const next = { ...(await this.read()), ...patch };
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.${tokenWriteSeq++}.tmp`;
    try {
      await Bun.write(tmp, JSON.stringify(next, null, 2));
      await rename(tmp, this.#path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.#path);
    } catch {
      /* already gone */
    }
    // Drop a not-yet-migrated legacy file too — otherwise the next read would
    // migrate it back in and resurrect credentials the caller just revoked.
    if (this.#legacyPath && this.#legacyPath !== this.#path) {
      await unlink(this.#legacyPath).catch(() => undefined);
    }
  }
}

/** The subset of the SDK's OAuthClientProvider we implement (structural). */
export interface McpOAuthProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: {
    redirect_uris: string[];
    client_name?: string;
    scope?: string;
    grant_types: string[];
    response_types: string[];
    token_endpoint_auth_method: string;
  };
  clientInformation(): Promise<unknown> | unknown;
  saveClientInformation(info: unknown): Promise<void>;
  tokens(): Promise<unknown> | unknown;
  saveTokens(tokens: unknown): Promise<void>;
  redirectToAuthorization(url: URL): Promise<void>;
  saveCodeVerifier(verifier: string): Promise<void>;
  codeVerifier(): Promise<string>;
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void>;
}

export interface McpOAuthDeps {
  store?: McpTokenStore;
  logger?: Logger;
  /** Open the authorization URL in a browser (best-effort). Injectable for tests. */
  openUrl?: (url: string) => void;
}

const DEFAULT_REDIRECT = "http://localhost:8976/callback";

/** Build an OAuthClientProvider backed by a per-server file store. */
export function createMcpOAuthProvider(
  server: string,
  cfg: McpOAuth,
  deps: McpOAuthDeps = {},
): McpOAuthProvider {
  // No legacy fallback for an explicit tokenStore override — the user names
  // that path directly; only the derived default path changed shape.
  const store =
    deps.store ??
    new McpTokenStore(
      mcpTokenStorePath(server, cfg.tokenStore),
      cfg.tokenStore ? undefined : legacyMcpTokenStorePath(server),
    );
  const log = deps.logger ?? createLogger("mcp-oauth");
  const redirectUrl = cfg.redirectUri ?? DEFAULT_REDIRECT;

  return {
    redirectUrl,
    clientMetadata: {
      redirect_uris: [redirectUrl],
      ...(cfg.clientName ? { client_name: cfg.clientName } : { client_name: "vibe-codr" }),
      ...(cfg.scopes?.length ? { scope: cfg.scopes.join(" ") } : {}),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    async clientInformation() {
      const stored = (await store.read()).clientInformation;
      if (stored) return stored;
      // A pre-registered client id skips dynamic registration.
      return cfg.clientId ? { client_id: cfg.clientId } : undefined;
    },
    async saveClientInformation(info) {
      await store.merge({ clientInformation: info });
    },
    async tokens() {
      return (await store.read()).tokens;
    },
    async saveTokens(tokens) {
      await store.merge({ tokens });
    },
    async redirectToAuthorization(url) {
      rememberOAuthCallbackState(redirectUrl, url.searchParams.get("state") ?? undefined);
      log.info(`MCP "${server}" needs authorization — open:\n${url.toString()}`);
      try {
        (deps.openUrl ?? openInBrowser)(url.toString());
      } catch {
        /* best-effort; the URL is logged above */
      }
    },
    async saveCodeVerifier(verifier) {
      await store.merge({ codeVerifier: verifier });
    },
    async codeVerifier() {
      const v = (await store.read()).codeVerifier;
      if (!v) throw new Error(`no PKCE code verifier stored for MCP server "${server}"`);
      return v;
    },
    async invalidateCredentials(scope) {
      if (scope === "all") return store.clear();
      const patch: Partial<StoredMcpAuth> = {};
      if (scope === "client") patch.clientInformation = undefined;
      if (scope === "tokens") patch.tokens = undefined;
      if (scope === "verifier") patch.codeVerifier = undefined;
      await store.merge(patch);
    },
  };
}

/** Parse an OAuth redirect request URL into its `code` / `error` params. Pure
 * (no I/O) so the callback parsing is unit-testable without a live server. */
export function extractOAuthCallbackParams(reqUrl: string): {
  code?: string;
  error?: string;
  state?: string;
} {
  try {
    // reqUrl may be a bare path+query ("/callback?code=…") — resolve against a
    // dummy origin so the URL constructor accepts it.
    const u = new URL(reqUrl, "http://localhost");
    const code = u.searchParams.get("code") ?? undefined;
    const error = u.searchParams.get("error") ?? undefined;
    const state = u.searchParams.get("state") ?? undefined;
    return { ...(code ? { code } : {}), ...(error ? { error } : {}), ...(state ? { state } : {}) };
  } catch {
    return {};
  }
}

interface OAuthCallbackWaiter {
  state?: string;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface OAuthCallbackServer {
  server: { stop: (closeActiveConnections?: boolean) => void };
  waitersByState: Map<string, OAuthCallbackWaiter>;
  fallbackWaiters: OAuthCallbackWaiter[];
}

const callbackServers = new Map<string, OAuthCallbackServer>();
const pendingCallbackStates = new Map<string, string[]>();

function callbackKey(target: URL): string {
  const port = String(Number(target.port) || (target.protocol === "https:" ? 443 : 80));
  return `${target.protocol}//${target.hostname}:${port}${target.pathname}`;
}

function rememberOAuthCallbackState(redirectUrl: string, state: string | undefined): void {
  if (!state) return;
  const key = callbackKey(new URL(redirectUrl));
  const pending = pendingCallbackStates.get(key) ?? [];
  pending.push(state);
  pendingCallbackStates.set(key, pending);
}

function takeOAuthCallbackState(key: string): string | undefined {
  const pending = pendingCallbackStates.get(key);
  const state = pending?.shift();
  if (pending && pending.length === 0) pendingCallbackStates.delete(key);
  return state;
}

function removeWaiter(key: string, waiter: OAuthCallbackWaiter): void {
  const entry = callbackServers.get(key);
  if (!entry) return;
  if (waiter.state) entry.waitersByState.delete(waiter.state);
  else entry.fallbackWaiters = entry.fallbackWaiters.filter((w) => w !== waiter);
  if (entry.waitersByState.size || entry.fallbackWaiters.length) return;
  callbackServers.delete(key);
  setTimeout(() => {
    try {
      entry.server.stop(true);
    } catch {
      /* already stopped */
    }
  }, 0);
}

function settleWaiter(
  key: string,
  waiter: OAuthCallbackWaiter,
  err: Error | null,
  code?: string,
): void {
  clearTimeout(waiter.timer);
  removeWaiter(key, waiter);
  if (err) waiter.reject(err);
  else waiter.resolve(code as string);
}

function getCallbackServer(target: URL, key: string): OAuthCallbackServer {
  const existing = callbackServers.get(key);
  if (existing) return existing;
  const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  const entry: OAuthCallbackServer = {
    server: Bun.serve({
      port,
      hostname: target.hostname,
      fetch(req) {
        const reqUrl = new URL(req.url);
        if (reqUrl.pathname !== target.pathname) {
          return new Response("Unknown OAuth callback path.", {
            status: 404,
            headers: { "content-type": "text/plain" },
          });
        }
        const { code, error, state } = extractOAuthCallbackParams(req.url);
        const waiter = state ? entry.waitersByState.get(state) : entry.fallbackWaiters[0];
        if (!waiter) {
          return new Response("No matching OAuth callback is waiting. You can close this tab.", {
            status: 400,
            headers: { "content-type": "text/plain" },
          });
        }
        if (error) {
          settleWaiter(key, waiter, new Error(`OAuth authorization denied: ${error}`));
          return new Response(`Authorization failed: ${error}. You can close this tab.`, {
            status: 400,
            headers: { "content-type": "text/plain" },
          });
        }
        if (code) {
          settleWaiter(key, waiter, null, code);
          return new Response(
            "Authorization complete — you can close this tab and return to the terminal.",
            {
              headers: { "content-type": "text/plain" },
            },
          );
        }
        return new Response("Waiting for the OAuth callback…", {
          headers: { "content-type": "text/plain" },
        });
      },
    }),
    waitersByState: new Map(),
    fallbackWaiters: [],
  };
  callbackServers.set(key, entry);
  return entry;
}

/** Serve the loopback OAuth redirect and resolve with the authorization `code`.
 * One listener is shared per redirect host/port/path, so concurrent OAuth flows
 * on the same redirect URL are routed by the authorization `state` parameter
 * remembered from redirectToAuthorization. Flows without state keep FIFO fallback
 * compatibility. Rejects on an `error` param, blank code, listen failure, or
 * timeout. */
export function waitForOAuthCallback(redirectUrl: string, timeoutMs = 120_000): Promise<string> {
  const target = new URL(redirectUrl);
  const key = callbackKey(target);
  const state = takeOAuthCallbackState(key);
  return new Promise<string>((resolve, reject) => {
    let entry: OAuthCallbackServer;
    try {
      entry = getCallbackServer(target, key);
    } catch (err) {
      reject(
        new Error(
          `could not listen on ${target.host} for the OAuth callback: ${(err as Error).message}`,
        ),
      );
      return;
    }
    const waiter: OAuthCallbackWaiter = {
      ...(state ? { state } : {}),
      resolve,
      reject,
      timer: setTimeout(
        () =>
          settleWaiter(
            key,
            waiter,
            new Error(`timed out waiting for the OAuth callback on ${target.host}`),
          ),
        timeoutMs,
      ),
    };
    if (state) entry.waitersByState.set(state, waiter);
    else entry.fallbackWaiters.push(waiter);
  });
}

/** Best-effort "open this URL in the default browser" across platforms. */
function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* headless / no browser — the caller has already logged the URL */
  }
}
