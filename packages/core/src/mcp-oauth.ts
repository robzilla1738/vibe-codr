import { join, dirname } from "node:path";
import { mkdir, unlink } from "node:fs/promises";
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

/** Resolve where a server's OAuth state lives (honoring an explicit override). */
export function mcpTokenStorePath(server: string, override?: string): string {
  if (override) return override.startsWith("~") ? join(homeDir(), override.slice(1)) : override;
  const safe = server.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(vibeConfigDir(), "mcp", `${safe}.json`);
}

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || ".";
}

/** A tiny JSON-file store for one server's OAuth state (atomic-ish overwrite). */
export class McpTokenStore {
  #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  async read(): Promise<StoredMcpAuth> {
    try {
      return JSON.parse(await Bun.file(this.#path).text()) as StoredMcpAuth;
    } catch {
      return {};
    }
  }

  /** Merge `patch` into the stored state (create parent dir as needed). */
  async merge(patch: Partial<StoredMcpAuth>): Promise<void> {
    const next = { ...(await this.read()), ...patch };
    await mkdir(dirname(this.#path), { recursive: true });
    await Bun.write(this.#path, JSON.stringify(next, null, 2));
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.#path);
    } catch {
      /* already gone */
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
  const store = deps.store ?? new McpTokenStore(mcpTokenStorePath(server, cfg.tokenStore));
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
