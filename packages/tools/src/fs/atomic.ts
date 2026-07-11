import { rename, chmod, rm } from "node:fs/promises";
import { statSync, lstatSync, realpathSync } from "node:fs";

/** Monotonic per-process counter, paired with `process.pid` in the temp filename
 *  so two concurrent writers (different locks, same process) never collide on
 *  one temp path. Matches the session-store / memory-store / ledger discipline. */
let writeSeq = 0;

/**
 * Resolve a symlink to the real file it points at. A `rename(2)` swap on the
 * link itself would replace the LINK with a regular file and strand its target
 * byte-for-byte stale; writing THROUGH a link must instead update the target
 * in place, so we resolve it and land the atomic swap on the real path (its
 * temp sits beside it, staying on one filesystem). `lstat` (not `stat`) so the
 * link is detected rather than followed; a non-symlink — or a path that
 * doesn't exist yet (a fresh create) — is returned unchanged.
 *
 * NOTE on POSIX semantics: `chmod(2)` follows symlinks, so a `chmodSync` on a
 * link always chmods its target. `lstat(link).mode` and `stat(link).mode`
 * therefore always reflect the SAME inode at the same moment — there is no
 * portable Node API to set the link's mode independently. Tests that want a
 * link and its target at different modes need `lchmod` (no portable Node
 * binding) or a kernel-special filesystem; "chmod the link" just chmods the
 * target, so the test cannot distinguish a symlink-rename from a target-write.
 */
function derefSymlink(full: string): string {
  try {
    if (lstatSync(full).isSymbolicLink()) return realpathSync(full);
  } catch {
    // Nothing at `full` (or an unreadable link) — nothing to dereference.
  }
  return full;
}

/**
 * Replace `full`'s contents ATOMICALLY: temp in the SAME directory (rename is
 * atomic only within one filesystem — a temp in `/tmp` could cross a mount
 * boundary and silently degrade to a copy), then rename over the target. A
 * crash mid-write leaves the ORIGINAL byte-for-byte intact — the torn bytes
 * only ever land in the temp, never the real path, closing the truncation
 * window an in-place `Bun.write` leaves open.
 *
 * Permission handling is intentionally INSIDE this function, on the post-deref
 * `target` — the inode that the rename will land on:
 *
 *   - Mode captured on `full` (a symlink) and applied to a tmp later renamed
 *     to `target` (the resolved path) is a TOCTOU window: an external
 *     symlink-swap or chmod between the outer stat and the inner rename
 *     leaks the old mode onto the wrong inode. Stat-on-target closes it.
 *   - A missing `target` (fresh create, or a sibling writer that deleted
 *     between our deref and our stat) keeps mode undefined → no chmod →
 *     `Bun.write` honors the running umask, the same default a direct
 *     create would have given it. Avoids hardcoding 0o644 (wrong under a
 *     restrictive umask) and shuts the exists→statSync delete race.
 *
 * On any failure we unlink our own temp and re-throw so the caller still
 * learns the write failed. Mirrors the session store's temp+rename discipline
 * (pid + counter suffix, cleanup-on-failure).
 */
export async function atomicReplace(full: string, data: string | Uint8Array): Promise<void> {
  const target = derefSymlink(full);

  // Capture mode on the resolved target right before we stage the temp.
  // ENOENT (or unreadable) → fresh-create path: no chmod, Bun.write honors
  // the umask. This also swallows the exists→statSync delete race in the
  // write tool cleanly (C-2 in bug2.md).
  let mode: number | undefined;
  try {
    mode = statSync(target).mode;
  } catch {
    // swallow → umask governs the new file's mode
  }

  const tmp = `${target}.${process.pid}.${writeSeq++}.tmp`;
  try {
    await Bun.write(tmp, data);
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
