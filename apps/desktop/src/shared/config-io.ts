/**
 * Config file I/O for the Electron main process.
 *
 * Reads and writes the vibe-codr config files (JSONC-compatible) at the same
 * paths the engine uses: global `~/.config/vibe-codr/config.json` and project
 * `<cwd>/.vibe/config.json`. This mirrors `@vibe/config`'s `loadConfig` /
 * `writeGlobalConfig` but is self-contained for the Electron shell so it does
 * not need the Bun runtime or the `@vibe/config` package.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ConfigScope, VibeConfig } from "./config-schema";

/** Strip line and block comments (string-aware).
 * Throws if a block comment is left unclosed so a missing closer cannot
 * silently swallow the rest of the file. */
function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (ch === "\n") { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (next !== undefined) { out += next; i++; }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') { inString = true; out += ch; }
    else if (ch === "/" && next === "/") { inLine = true; i++; }
    else if (ch === "/" && next === "*") { inBlock = true; i++; }
    else { out += ch; }
  }
  if (inBlock) {
    throw new Error("Unclosed block comment in JSONC");
  }
  return out;
}

/** Strip trailing commas (string-aware) so JSONC parses with `JSON.parse`. */
function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (input[i + 1] !== undefined) out += input[++i]!;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j++;
      if (input[j] === "}" || input[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}


/** Clone-surviving security-notices key the engine attaches to a loaded config
 * (see @vibe/config). Never persisted to disk — strip it before writing so a
 * round-trip through the Electron shell doesn't freeze a transient notice into
 * the user's config file. */
export const SECURITY_NOTICES_KEY = "__vibeSecurityNotices";

/** Drop the clone-surviving notices bag before writing config to disk. */
function stripSecurityNotices<T extends Record<string, unknown>>(value: T): T {
  if (!(SECURITY_NOTICES_KEY in value)) return value;
  const copy = { ...value };
  delete copy[SECURITY_NOTICES_KEY];
  return copy;
}

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Find object keys that can mutate or shadow JavaScript prototypes. Config
 * records use user-provided ids (provider, MCP server, model, language), so a
 * denylisted key must be reported rather than silently disappearing during a
 * safe merge. Arrays are traversed because hooks/permissions are structured
 * data too. The WeakSet also makes this safe for direct callers that hand us a
 * cyclic object, even though Electron IPC itself only supplies cloneable data.
 */
function dangerousConfigKeyPath(value: unknown): string | null {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, path: string): string | null => {
    if (typeof current !== "object" || current === null) return null;
    if (seen.has(current)) return null;
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const found = visit(current[index], `${path}[${index}]`);
        if (found) return found;
      }
      return null;
    }
    for (const [key, child] of Object.entries(current)) {
      const childPath = path ? `${path}.${key}` : key;
      if (DANGEROUS_KEYS.has(key)) return childPath;
      const found = visit(child, childPath);
      if (found) return found;
    }
    return null;
  };
  return visit(value, "");
}

function assertSafeConfigKeys(value: unknown, label: "Config" | "Config patch"): void {
  const path = dangerousConfigKeyPath(value);
  if (path) throw new Error(`${label} contains reserved key ${path}`);
}

/** Deep-merge for writes: `null` deletes, `undefined` is a no-op. */
function mergeForWrite(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (value === undefined) continue;
    if (value === null) { delete out[key]; continue; }
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = mergeForWrite(existing, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Exported for pure tests of the merge key denylist. */
export function mergeConfigForWrite(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return mergeForWrite(base, patch);
}

export function globalConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "vibe-codr", "config.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".vibe", "config.json");
}

export function configPathForScope(scope: ConfigScope, cwd?: string): string {
  if (scope === "global") return globalConfigPath();
  if (!cwd) throw new Error("Project config requires a cwd");
  return projectConfigPath(cwd);
}

/** Config reads refuse multi-megabyte files (Settings open must not OOM main). */
export const CONFIG_MAX_READ_BYTES = 2_000_000;
/** Config writes use the same ceiling as reads so the app cannot create a file
 * it will refuse to open on the next Settings load. */
export const CONFIG_MAX_WRITE_BYTES = CONFIG_MAX_READ_BYTES;

export async function readConfigFile(path: string): Promise<{ config: VibeConfig; raw: string } | null> {
  if (!existsSync(path)) return null;
  const { stat } = await import("node:fs/promises");
  try {
    const st = await stat(path);
    if (st.size > CONFIG_MAX_READ_BYTES) {
      throw new Error(`Config at ${path} exceeds ${CONFIG_MAX_READ_BYTES} bytes`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("exceeds")) throw err;
    /* fall through to read — race with delete */
  }
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > CONFIG_MAX_READ_BYTES) {
    throw new Error(`Config at ${path} exceeds ${CONFIG_MAX_READ_BYTES} bytes`);
  }
  const cleaned = stripTrailingCommas(stripJsonComments(raw));
  const parsed = JSON.parse(cleaned) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error(`Config at ${path} is not a JSON object — fix or remove it before opening Settings`);
  }
  assertSafeConfigKeys(parsed, "Config");
  return { config: parsed as VibeConfig, raw };
}

/** Atomic temp+rename JSON write — a crash mid-write cannot truncate the
 * live config into unparseable garbage (BUG-092 parity with @vibe/config).
 * The temp file is PID+timestamp-named and cleaned up on failure. */
/** Secret-bearing global config should not be world-readable. */
const SECRET_FILE_MODE = 0o600;

async function atomicWriteJson(path: string, value: Record<string, unknown>): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const stripped = stripSecurityNotices(value);
  const serialized = `${JSON.stringify(stripped, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > CONFIG_MAX_WRITE_BYTES) {
    throw new Error(`Config at ${path} exceeds ${CONFIG_MAX_WRITE_BYTES} bytes`);
  }
  const tmp = join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, serialized, {
      encoding: "utf8",
      mode: SECRET_FILE_MODE,
    });
    await rename(tmp, path);
    // rename may not preserve mode on all platforms; enforce on the final path.
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(path, SECRET_FILE_MODE);
    } catch {
      /* best-effort on platforms without chmod */
    }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Per-path write serialization. The engine fires config writes without
 * awaiting, so two rapid settings changes would both read the same `existing`
 * and the later write would clobber the earlier one's key. Chaining each path
 * through its own promise makes every write see the prior write's result. */
const writeChains = new Map<string, Promise<unknown>>();

function scheduleWrite<T>(path: string, work: () => Promise<T>): Promise<T> {
  const chain = writeChains.get(path) ?? Promise.resolve();
  const result = chain.then(work, work);
  // Advance the chain past this write's settlement, swallowing errors so one
  // failed write doesn't wedge every subsequent persist on that path.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(path, tail);
  // Keep serialization state only while work is pending. A long-running app
  // may visit many projects; settled path entries must not accumulate forever.
  void tail.then(() => {
    if (writeChains.get(path) === tail) writeChains.delete(path);
  });
  return result;
}

export async function writeConfigFile(
  path: string,
  patch: Record<string, unknown>,
): Promise<VibeConfig> {
  if (!isPlainObject(patch)) {
    throw new Error("Config patch must be a plain object");
  }
  assertSafeConfigKeys(patch, "Config patch");
  return scheduleWrite(path, async () => {
    let existing: Record<string, unknown> = {};
    if (existsSync(path)) {
      // Refuse to overwrite a corrupt on-disk config — a parse failure used to
      // fall through to `{}` and wipe models/keys/MCP with the patch alone.
      const read = await readConfigFile(path);
      if (!read) {
        throw new Error(`Config at ${path} could not be read`);
      }
      if (!isPlainObject(read.config)) {
        throw new Error(`Config at ${path} is not a JSON object — fix or remove it before saving`);
      }
      existing = read.config as Record<string, unknown>;
    }
    const merged = mergeForWrite(existing, patch);
    await atomicWriteJson(path, merged);
    return merged as VibeConfig;
  });
}

/**
 * Read → merge → validate → write under a single per-path lock so concurrent
 * Settings saves cannot persist an unvalidated merge.
 * Returns `{ ok: true, config }` or `{ ok: false, error }`.
 */
export async function writeConfigFileValidated(
  path: string,
  patch: Record<string, unknown>,
  validate: (merged: Record<string, unknown>) => string[],
): Promise<{ ok: true; config: VibeConfig } | { ok: false; error: string }> {
  if (!isPlainObject(patch)) {
    return { ok: false, error: "Config patch must be a plain object" };
  }
  try {
    assertSafeConfigKeys(patch, "Config patch");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const result = await scheduleWrite(path, async () => {
      let existing: Record<string, unknown> = {};
      if (existsSync(path)) {
        const read = await readConfigFile(path);
        if (!read) throw new Error(`Config at ${path} could not be read`);
        if (!isPlainObject(read.config)) {
          throw new Error(`Config at ${path} is not a JSON object — fix or remove it before saving`);
        }
        existing = read.config as Record<string, unknown>;
      }
      const merged = mergeForWrite(existing, patch);
      const errors = validate(merged);
      if (errors.length) {
        return { ok: false as const, error: `Invalid configuration: ${errors.join("; ")}` };
      }
      await atomicWriteJson(path, merged);
      return { ok: true as const, config: merged as VibeConfig };
    });
    return result;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Memory file paths ────────────────────────────────────────────────────

export function globalMemoryPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "vibe-codr", "VIBE.md");
}

export function projectMemoryPath(cwd: string): string {
  return join(cwd, "VIBE.md");
}

export function memoryPathForScope(scope: ConfigScope, cwd?: string): string {
  if (scope === "global") return globalMemoryPath();
  if (!cwd) throw new Error("Project memory requires a cwd");
  return projectMemoryPath(cwd);
}

/** Custom instructions (VIBE.md) — hard cap so a paste cannot blow disk/memory. */
export const MEMORY_MAX_BYTES = 1_500_000;

export async function readMemoryFile(path: string): Promise<{ content: string; exists: boolean }> {
  if (!existsSync(path)) return { content: "", exists: false };
  const { stat } = await import("node:fs/promises");
  try {
    const st = await stat(path);
    if (st.size > MEMORY_MAX_BYTES) {
      throw new Error(`Memory file exceeds ${MEMORY_MAX_BYTES} bytes`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("exceeds")) throw err;
  }
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content, "utf8") > MEMORY_MAX_BYTES) {
    throw new Error(`Memory file exceeds ${MEMORY_MAX_BYTES} bytes`);
  }
  return { content, exists: true };
}

export async function writeMemoryFile(path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MEMORY_MAX_BYTES) {
    throw new Error(`Memory file exceeds ${MEMORY_MAX_BYTES} bytes`);
  }
  return scheduleWrite(path, async () => {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.VIBE.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(tmp, content, { encoding: "utf8", mode: SECRET_FILE_MODE });
      await rename(tmp, path);
      try {
        const { chmod } = await import("node:fs/promises");
        await chmod(path, SECRET_FILE_MODE);
      } catch {
        /* best-effort */
      }
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  });
}

/**
 * Read the existing config at `path`, deep-merge `patch` into it, and return
 * the merged result WITHOUT writing to disk. Used by the IPC write handler to
 * validate the merged config before persisting (mirroring the engine's
 * `ConfigSchema.safeParse` gate in `writeGlobalConfig`).
 */
export async function previewMergedConfig(
  path: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isPlainObject(patch)) {
    throw new Error("Config patch must be a plain object");
  }
  assertSafeConfigKeys(patch, "Config patch");
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    const read = await readConfigFile(path);
    if (!read) {
      throw new Error(`Config at ${path} could not be read`);
    }
    if (!isPlainObject(read.config)) {
      throw new Error(`Config at ${path} is not a JSON object — fix or remove it before saving`);
    }
    existing = read.config as Record<string, unknown>;
  }
  return mergeForWrite(existing, patch);
}
