import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@vibe/shared";
import { ConfigSchema, type Config } from "./schema.ts";

/** Deep-merge plain objects (arrays are replaced, not concatenated). */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Strip `//` line and `/* *\/` block comments so config files may use JSONC.
 * String-aware single pass: a `//` or `/*` inside a JSON string value (e.g. a
 * URL "http://…", a path "a//b", or a regex) is preserved verbatim — only
 * comments outside string literals are removed.
 */
function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch; // keep the newline so line/column reporting stays sane
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Escape sequence: copy the escaped char verbatim so a `\"` doesn't end
        // the string and a `\\` is handled correctly.
        if (next !== undefined) {
          out += next;
          i++;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      inLine = true;
      i++;
    } else if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

async function readConfigFile(
  path: string,
): Promise<Record<string, unknown> | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const raw = await file.text();
    return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(
      `Failed to parse config at ${path}: ${(err as Error).message}`,
    );
  }
}

export interface LoadOptions {
  /** Project root to search for `.vibe/config.json`. Defaults to cwd. */
  cwd?: string;
  /** Highest-precedence overrides (e.g. from CLI flags). */
  overrides?: Partial<Config>;
}

/** The user-global config path (`~/.config/vibe-codr/config.json`). */
export function globalConfigPath(): string {
  return join(homedir(), ".config", "vibe-codr", "config.json");
}

/** Locations searched, lowest precedence first. */
export function configLocations(cwd: string): string[] {
  return [globalConfigPath(), join(cwd, ".vibe", "config.json")];
}

/**
 * Deep-merge for *writes*: like {@link deepMerge}, but a `null` patch value
 * DELETES that key from the result (so callers can clear a persisted setting,
 * e.g. resetting `subagent.model` to "inherit the main model"). `undefined` is
 * skipped (no-op), matching `deepMerge`.
 */
function mergeForWrite(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = mergeForWrite(existing, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Merge `patch` into the user-global config file (creating it if absent) and
 * write it back. Used by onboarding and the in-chat `/model` command to persist
 * model/provider/key changes outside any project. A `null` value in `patch`
 * deletes that key (clearing a setting). Returns the object that was written.
 */
export async function writeGlobalConfig(
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const path = globalConfigPath();
  const existing = (await readConfigFile(path)) ?? {};
  const merged = mergeForWrite(existing, patch);
  await Bun.write(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

/**
 * Load and validate config by deep-merging: schema defaults -> global ->
 * project -> CLI overrides. Throws `ConfigError` on invalid files/values.
 */
export async function loadConfig(opts: LoadOptions = {}): Promise<Config> {
  const cwd = opts.cwd ?? process.cwd();
  let merged: Record<string, unknown> = {};

  for (const path of configLocations(cwd)) {
    const fileConfig = await readConfigFile(path);
    if (fileConfig) merged = deepMerge(merged, fileConfig);
  }

  if (opts.overrides) {
    merged = deepMerge(merged, opts.overrides as Record<string, unknown>);
  }

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration: ${result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/** Synchronous defaults, useful for tests and headless boot before disk read. */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}
