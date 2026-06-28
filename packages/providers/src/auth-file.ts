import { existsSync, readFileSync } from "node:fs";
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

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
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
  if (!existsSync(full)) return undefined;
  let text: string;
  try {
    text = readFileSync(full, "utf8").trim();
  } catch {
    return undefined;
  }
  if (!text) return undefined;

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return text; // plain-text token file
  }

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
