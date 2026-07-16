/**
 * Read a text file's contents, returning null ONLY when the file genuinely does
 * not exist. Any other error (EACCES, EISDIR, ENOTDIR, transient FS fault) is
 * PROPAGATED so a forbidden file is never silently treated as empty — that
 * was a real hidden bug in the previous `.catch(() => "")` sites, where a
 * permission failure read as "no prior fact" and overwrote with the new write
 * without warning.
 *
 * Bun's `Bun.file(path).text()` is implemented in native code that opens the
 * kernel FD, reads to completion, and closes — all atomically with respect
 * to a concurrent external `unlink(2)`. An open FD outlives its unlinked
 * pathname on POSIX, so the read is race-free by construction: any ENOENT
 * we observe here is "the file was missing when we tried to open it", not
 * "the file was deleted after we decided to read it". The TOCTOU in the
 * previous `await file.exists(); await file.text()` pattern is gone because
 * there is no separate `exists()` call to race against — this is the entire
 * point of the C-2 fix.
 *
 * Companion to `packages/tools/src/fs/atomic.ts`: that primitive handles
 * WRITE-side atomicity (temp+rename, mode capture on post-deref target,
 * ENOENT → umask-default); this one handles READ-side atomicity. Together
 * they give every file-mutating tool a single, race-free I/O vocabulary.
 */
export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Read a file's raw bytes, returning null ONLY when the file genuinely does
 * not exist. Same ENOENT→null / EACCES-propagation contract as {@link
 * readTextIfExists}. Use this when the caller needs to strict-decode the
 * bytes (e.g. `edit`'s UTF-8 binary-refusal check) — the lossy `Bun.file().
 * text()` would silently map invalid bytes to U+FFFD, masking the very
 * binary content the caller is trying to detect.
 */
export async function readBytesIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
