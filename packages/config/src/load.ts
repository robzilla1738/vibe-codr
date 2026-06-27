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

/** Strip `//` and `/* *\/` comments so config files may use JSONC. */
function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
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

/** Locations searched, lowest precedence first. */
export function configLocations(cwd: string): string[] {
  return [
    join(homedir(), ".config", "vibe-codr", "config.json"),
    join(cwd, ".vibe", "config.json"),
  ];
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
