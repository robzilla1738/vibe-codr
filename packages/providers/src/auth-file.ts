import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/** JSON fields commonly holding an API key / OAuth access token. */
const COMMON_KEYS = [
  "OPENAI_API_KEY",
  "api_key",
  "apiKey",
  "access_token",
  "accessToken",
  "key",
  "token",
  "tokens.access_token",
];

interface TokenFileCacheEntry {
  signature: string;
  text: string;
  json: unknown;
}

const TOKEN_FILE_CACHE_MAX = 32;
const tokenFileCache = new Map<string, TokenFileCacheEntry>();

function fileSignature(path: string): string | undefined {
  try {
    const value = statSync(path);
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** Non-secret version used to invalidate cached provider/model instances. */
export function tokenFileVersion(path: string): string {
  const full = expandHome(path);
  return fileSignature(full) ?? "missing";
}

function getPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
      obj,
    );
}

/**
 * Read a credential from a file (supports `~`). A JSON file is searched at
 * `jsonPath` (dot-path) or, failing that, a set of common key fields — this is
 * how a subscription/OAuth token stored by another CLI (e.g. Codex's
 * `~/.codex/auth.json`) is reused. A non-JSON file is treated as the raw token.
 * Returns undefined if the file is missing, unreadable, or empty.
 */
export function readTokenFile(path: string, jsonPath?: string): string | undefined {
  const full = expandHome(path);
  const signature = fileSignature(full);
  if (!signature) {
    tokenFileCache.delete(full);
    return undefined;
  }
  let cached = tokenFileCache.get(full);
  if (!cached || cached.signature !== signature) {
    let text: string;
    try {
      text = readFileSync(full, "utf8").trim();
    } catch {
      return undefined;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    cached = { signature, text, json };
    tokenFileCache.delete(full);
    tokenFileCache.set(full, cached);
    while (tokenFileCache.size > TOKEN_FILE_CACHE_MAX) {
      const oldest = tokenFileCache.keys().next().value;
      if (typeof oldest !== "string") break;
      tokenFileCache.delete(oldest);
    }
  }
  const { text, json } = cached;
  if (!text) return undefined;
  if (json === undefined) return text; // plain-text token file

  if (jsonPath) {
    const v = getPath(json, jsonPath);
    return typeof v === "string" && v ? v : undefined;
  }
  for (const key of COMMON_KEYS) {
    const v = getPath(json, key);
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}
