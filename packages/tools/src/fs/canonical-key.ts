import { realpathSync } from "node:fs";
import { dirname, basename, join } from "node:path";

/** macOS (APFS/HFS+) and Windows (NTFS) default to case-insensitive filesystems,
 * where `src/App.ts` and `SRC/app.ts` are the SAME file. */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/**
 * Canonicalize an absolute path so different spellings of the SAME on-disk file
 * map to one lock key: resolve symlinks and on-disk casing (critical on
 * case-insensitive filesystems like macOS's default APFS, where `src/App.ts`
 * and `SRC/app.ts` are the same file). For a path that doesn't exist yet (a
 * `write` creating a new file) we canonicalize the nearest existing ancestor and
 * re-append the rest, then fall back to the raw path.
 *
 * Lives in its own module (not `toolset.ts`) so the freshness registry can use
 * it without creating an import cycle through `toolset → builtins → edit/write/
 * read → freshness → toolset`. Shared by the per-file write lock
 * (`createFileLock`) and the stale-write guard (`FreshnessRegistry`).
 */
export function canonicalLockKey(absPath: string): string {
  let key: string;
  try {
    key = realpathSync.native(absPath);
  } catch {
    // Path doesn't exist yet (a `write` creating a new file): canonicalize the
    // nearest existing ancestor and re-attach the leaf.
    try {
      key = join(realpathSync.native(dirname(absPath)), basename(absPath));
    } catch {
      key = absPath;
    }
  }
  // On a case-insensitive filesystem every spelling of one file is the SAME file,
  // so fold the whole key's case to one canonical form. This must apply to BOTH
  // branches: `realpathSync` returns the real on-disk casing for a file that
  // exists but the RAW leaf for one that doesn't, so without folding, a new-file
  // write (`src/App.ts` → `app.ts`) and a later existing-file write (`→ App.ts`)
  // would get distinct keys and two subagents could race the same path.
  return CASE_INSENSITIVE_FS ? key.toLowerCase() : key;
}
