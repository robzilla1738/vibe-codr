import { statSync, realpathSync } from "node:fs";

/**
 * Stale-write guard (Claude Code / Aider parity). Nothing else in the engine
 * notices when a file changes on disk between an agent's `read` and a later
 * `edit`/`write` — a concurrent EXTERNAL edit (the user's editor, a formatter,
 * another process) would be silently clobbered the moment `oldString` still
 * happens to match. This module tracks the on-disk mtime of every file a session
 * has read so the mutating tools can refuse to overwrite a file that moved out
 * from under them and ask the model to re-read first.
 *
 * The registry is module-level and keyed by `sessionId`: a tool call carries no
 * cross-call state of its own, and the mapping must survive the many read/edit
 * invocations of one turn (and one session). It is NOT a read-before-edit
 * requirement — a file the session never read is treated as fresh, so
 * write-new-file and deliberate blind-overwrite flows keep working.
 */

/** macOS (APFS/HFS+) and Windows (NTFS) default to case-insensitive filesystems,
 * where `src/App.ts` and `SRC/app.ts` are the SAME file. */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/** Per-session cap on tracked paths. A long session touches many files; without
 * a bound the registry would grow for the life of the process. Oldest-seen paths
 * are evicted first (LRU) — a file evicted from tracking simply falls back to
 * "not stale", which is the safe/no-op direction. */
const MAX_PATHS_PER_SESSION = 2000;

/** sessionId → (canonical absolute path → last-seen mtimeMs). The inner Map's
 * insertion order doubles as the LRU order: re-recording a path re-inserts it at
 * the tail, so `keys().next()` is always the least-recently-seen entry. */
const registry = new Map<string, Map<string, number>>();

/**
 * Canonical registry key for a file that EXISTS on disk: resolve symlinks and
 * on-disk casing so a read spelled `src/App.ts` and an edit spelled `SRC/app.ts`
 * map to the SAME entry on a case-insensitive filesystem. Mirrors the write
 * lock's `canonicalLockKey` so the freshness check and the lock agree on file
 * identity. Callers only ever pass paths they have just stat'd, so `realpathSync`
 * succeeds; the raw path is a defensive fallback.
 */
function canonicalKey(absPath: string): string {
  let key: string;
  try {
    key = realpathSync.native(absPath);
  } catch {
    key = absPath;
  }
  return CASE_INSENSITIVE_FS ? key.toLowerCase() : key;
}

/** Current on-disk mtime of `absPath` in ms, or undefined if it can't be stat'd
 * (the file is missing) — a missing file is neither tracked nor flagged. */
function mtimeOf(absPath: string): number | undefined {
  try {
    return statSync(absPath).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Record the file's current on-disk mtime as this session's last-seen version.
 * Called after a successful `read` (so the guard knows what the model saw) and
 * after our OWN `edit`/`write` (so our writes advance the baseline and never
 * self-flag as stale on the next mutation). A file that can't be stat'd is
 * ignored rather than tracked with a bogus timestamp.
 */
export function recordSeen(sessionId: string, absPath: string): void {
  const mtime = mtimeOf(absPath);
  if (mtime === undefined) return;
  const key = canonicalKey(absPath);
  let seen = registry.get(sessionId);
  if (!seen) {
    seen = new Map();
    registry.set(sessionId, seen);
  }
  // Delete-then-set so the entry moves to the tail (most-recently-seen) even on
  // a repeat record — keeps the LRU eviction order honest.
  seen.delete(key);
  seen.set(key, mtime);
  while (seen.size > MAX_PATHS_PER_SESSION) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/**
 * Whether `absPath` changed on disk since this session last recorded it. A file
 * the session never read is NOT stale (no read-before-edit requirement). A file
 * that vanished since we read it is left to the caller's own existence check.
 * `ageMs` is how much newer the on-disk copy is than the version we saw.
 */
export function assertFresh(
  sessionId: string,
  absPath: string,
): { stale: boolean; ageMs?: number } {
  const seen = registry.get(sessionId);
  if (!seen) return { stale: false };
  const recorded = seen.get(canonicalKey(absPath));
  if (recorded === undefined) return { stale: false };
  const current = mtimeOf(absPath);
  if (current === undefined) return { stale: false };
  if (current > recorded) return { stale: true, ageMs: current - recorded };
  return { stale: false };
}

/** Drop a session's tracking (call when a session ends so the registry doesn't
 * retain entries for finished sessions). */
export function clearSession(sessionId: string): void {
  registry.delete(sessionId);
}

/** Test hook: wipe the entire registry between tests for isolation. */
export function _resetFreshness(): void {
  registry.clear();
}
