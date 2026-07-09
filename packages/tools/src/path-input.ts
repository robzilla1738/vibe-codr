import { z } from "zod";

/**
 * Documented field name plus the aliases models commonly emit when they
 * confuse tool schemas (Claude Code / OpenAI / generic agent training data).
 * Order is priority: the first present string wins.
 */
export const PATH_FIELD_ALIASES = ["path", "file_path", "filePath", "file"] as const;

/**
 * Extract the path a tool call targets, accepting the documented `path` field
 * and common model aliases. Pure — used by schemas, the permission scope
 * extractor, and tests so a single list stays in lock-step.
 */
export function pickPathField(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
  for (const key of PATH_FIELD_ALIASES) {
    const v = o[key];
    // Empty string is not a usable path — keep scanning aliases so a model
    // that sent `path:""` + `file_path:"real.ts"` still resolves.
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Ensure a tool-input object carries the canonical `path` field when the model
 * only supplied an alias (`file_path` / `filePath` / `file`). Leaves input
 * untouched when `path` is already a non-empty string or no alias is present.
 * Pure.
 */
export function normalizePathAliases(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const o = input as Record<string, unknown>;
  if (typeof o.path === "string" && o.path.length > 0) return input;
  for (const key of PATH_FIELD_ALIASES) {
    if (key === "path") continue;
    const v = o[key];
    if (typeof v === "string" && v.length > 0) return { ...o, path: v };
  }
  return input;
}

/**
 * Zod object schema that accepts path under aliases before validating the
 * documented shape. Use for every built-in whose contract includes `path` so
 * AI-SDK schema validation does not reject recoverable model misspellings
 * with `path: expected string, received undefined`.
 */
export function withPathAliases<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess(normalizePathAliases, z.object(shape));
}
