import { dirname, basename, join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";

/**
 * Unicode whitespace variants that appear in real-world filenames — especially
 * macOS screenshot names, which use U+202F (NARROW NO-BREAK SPACE) before AM/PM
 * instead of a regular space (U+0020). When a user pastes the path with regular
 * spaces, `stat()` fails and the file is never found.
 */
const UNICODE_SPACES = /[\u00A0\u2009\u200A\u200B\u202F\u2060\uFEFF]/g;

/** Normalize Unicode whitespace variants to regular spaces for fuzzy matching. */
export function normalizeSpaces(s: string): string {
  return s.replace(UNICODE_SPACES, " ");
}

/**
 * `stat` with a Unicode-space fallback. macOS screenshot filenames use U+202F
 * (NARROW NO-BREAK SPACE) before AM/PM — when a user pastes the path with
 * regular spaces, `stat` misses. This retries by listing the parent directory
 * and matching the basename with all Unicode whitespace normalized to U+0020.
 * Returns both the stat result and the actual on-disk path (which may differ
 * from the input when the fallback fired).
 *
 * Shared by `expandMentions` (image attachment / @path mentions in core) and
 * the `read` tool (text file reading in tools) so both handle macOS screenshot
 * paths identically.
 */
export async function statResolve(
  full: string,
): Promise<{ info: Stats; actualPath: string } | null> {
  const direct = await stat(full).catch(() => null);
  if (direct) return { info: direct, actualPath: full };
  // Fallback: the filename may contain Unicode whitespace variants (U+202F,
  // U+00A0, …) that don't match the regular spaces the user typed. Only the
  // basename is fuzzed — directory components are user-typed and use regular
  // spaces.
  const dir = dirname(full);
  const base = basename(full);
  // Only fuzz when the basename contains whitespace — a filename with no
  // spaces can't have a Unicode-space mismatch. The user typed regular spaces;
  // the file on disk may have U+202F, U+00A0, etc. in their place.
  if (!/\s/.test(base)) return null;
  const normBase = normalizeSpaces(base);
  const entries = await readdir(dir).catch(() => null);
  if (!entries) return null;
  for (const entry of entries) {
    if (normalizeSpaces(entry) === normBase) {
      const actualPath = join(dir, entry);
      const info = await stat(actualPath).catch(() => null);
      if (info) return { info, actualPath };
    }
  }
  return null;
}
