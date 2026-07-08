import { canonicalLockKey } from "../fs/canonical-key.ts";

/** Current on-disk mtime of `absPath` in ms, or undefined if it can't be stat'd
 * (the file is missing) — a missing file is neither tracked nor flagged. */
function mtimeOf(absPath: string): number | undefined {
  try {
    return Bun.file(absPath).lastModified;
  } catch {
    return undefined;
  }
}

/**
 * Stale-write guard (Claude Code / Aider parity). Nothing else in the engine
 * notices when a file changes on disk between an agent's `read` and a later
 * `edit`/`write` — a concurrent EXTERNAL edit (the user's editor, a formatter,
 * another process) would be silently clobbered the moment `oldString` still
 * happens to match. This registry tracks the on-disk mtime of every file any
 * session in the tree has read so the mutating tools can refuse to overwrite a
 * file that moved out from under them and ask the model to re-read first.
 *
 * ## Per-session storage, tree-shared lifetime
 *
 * The registry is keyed by (sessionId, canonicalPath) → mtime. Each session
 * keeps its own per-path mtime: the "stale" check is "did THIS session's view
 * of the file go stale?" — a subagent that read at M1 is correctly flagged
 * when the disk moves to M2, even if a sibling subagent's view of the same
 * file is newer. The naive tree-wide alternative (one max-mtime per path)
 * would lose this: A reads M1, B writes M2 (entry mtime advances), A wants
 * to write — current M2 == entry M2, A is NOT flagged, A silently clobbers
 * a file it last saw at M1. Per-session storage closes that regression.
 *
 * The registry is owned by the engine (one per Session tree) and is cleared at
 * root-session teardown, so a worker-thread reuse can't leak a prior tree's
 * tracking into the next one. There is NO LRU cap: a long-running tree that
 * touches many files keeps them all tracked (a 2000-file LRU silently dropped
 * tracking past the cap — the bug2.md C-3 silent-degradation complaint). The
 * tree's lifetime is bounded by `clear()`; the engine's lifetime is bounded by
 * `finalize()`. Worst-case memory is `O(files_in_tree)`, which is acceptable
 * for any real workload.
 *
 * A file the tree never read is treated as fresh (no read-before-edit
 * requirement), so write-new-file and deliberate blind-overwrite flows keep
 * working.
 */
export class FreshnessRegistry {
  /** sessionId → (canonical absolute path → last-seen mtimeMs). The inner
   * Map's insertion order doubles as the LRU order; re-recording a path
   * moves it to the tail so the OLDEST-seen path is always `keys().next()`. */
  #registry = new Map<string, Map<string, number>>();

  /** Record a successful `read` of `absPath`: this session has now seen the
   * file at its current mtime. A later `edit`/`write` from the SAME session
   * is "stale" if the disk mtime has moved past this. Other sessions in the
   * tree have their own records (or none) — their views are independent. A
   * file that can't be stat'd is ignored rather than tracked with a bogus
   * timestamp. */
  recordRead(sessionId: string, absPath: string): void {
    const mtime = mtimeOf(absPath);
    if (mtime === undefined) return;
    const key = canonicalLockKey(absPath);
    let seen = this.#registry.get(sessionId);
    if (!seen) {
      seen = new Map();
      this.#registry.set(sessionId, seen);
    }
    // Delete-then-set so the entry moves to the tail (most-recently-seen)
    // even on a repeat record — preserves the documented LRU insertion
    // order for any future inspection.
    seen.delete(key);
    seen.set(key, mtime);
  }

  /** Record a write of `absPath` by `sessionId`: advance the session's own
   * baseline to the post-write mtime so the NEXT edit in the same session
   * doesn't mistake our change for an external one. A file that can't be
   * stat'd is ignored. */
  recordWrite(sessionId: string, absPath: string): void {
    // The semantics are identical to recordRead — both pin the session's
    // baseline to the current mtime. Kept as a distinct method so the call
    // site reads as intent ("we wrote this, advance our baseline") rather
    // than the underlying mtime pin.
    this.recordRead(sessionId, absPath);
  }

  /** Whether `absPath` changed on disk since THIS session last recorded it.
   * A file the session never read is NOT stale (no read-before-edit
   * requirement). A file that vanished since we read it is left to the
   * caller's own existence check (the file is gone → not stale, but the
   * caller's read-modify-write will fail anyway). `ageMs` is how much
   * newer the on-disk copy is than the version we saw. */
  assertFresh(
    sessionId: string,
    absPath: string,
  ): { stale: boolean; ageMs?: number } {
    const seen = this.#registry.get(sessionId);
    if (!seen) return { stale: false };
    const recorded = seen.get(canonicalLockKey(absPath));
    if (recorded === undefined) return { stale: false };
    const current = mtimeOf(absPath);
    if (current === undefined) return { stale: false };
    if (current > recorded) return { stale: true, ageMs: current - recorded };
    return { stale: false };
  }

  /** Drop a single session's tracking (called by the orchestrator when a
   * subagent settles, so the per-tree footprint stays bounded by active
   * sessions, not lifetime). The engine's preferred teardown is
   * {@link clear}, which drops every session in one call at root-session
   * end. */
  clearSession(sessionId: string): void {
    this.#registry.delete(sessionId);
  }

  /** Drop EVERY session's tracking. Called at root-session teardown so a
   * re-armed engine starts with a clean slate and the registry can't
   * leak across trees in a future worker-reuse mode. */
  clear(): void {
    this.#registry.clear();
  }
}
