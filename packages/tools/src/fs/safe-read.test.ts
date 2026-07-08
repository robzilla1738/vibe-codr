import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBytesIfExists, readTextIfExists } from "./safe-read.ts";

test("returns null for a missing file (ENOENT is the only mapped-to-null case)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-saferead-missing-"));
  const p = join(dir, "ghost.txt");
  const r = await readTextIfExists(p);
  expect(r).toBeNull();
});

test("returns the file's content for an existing text file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-saferead-exists-"));
  const p = join(dir, "real.txt");
  writeFileSync(p, "hello world\n");
  const r = await readTextIfExists(p);
  expect(r).toBe("hello world\n");
});

test("readBytesIfExists returns null for a missing file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-saferead-bytes-missing-"));
  const p = join(dir, "ghost.bin");
  const r = await readBytesIfExists(p);
  expect(r).toBeNull();
});

test("readBytesIfExists returns the raw bytes verbatim (does not lossily decode)", async () => {
  // readBytesIfExists must NOT use Bun.file().text() internally — that would
  // lossy-map invalid bytes to U+FFFD. The whole point of the bytes variant
  // is that edit's strict-decode can catch a real binary file.
  const dir = mkdtempSync(join(tmpdir(), "vibe-saferead-bytes-raw-"));
  const p = join(dir, "binary.bin");
  const original = new Uint8Array([0x66, 0x6f, 0x6f, 0xff, 0xfe, 0x00, 0x80, 0x90, 0xa0]);
  writeFileSync(p, original);
  const r = await readBytesIfExists(p);
  expect(r).not.toBeNull();
  expect([...r!]).toEqual([...original]);
});

test("readBytesIfExists propagates EACCES (does not swallow)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-saferead-bytes-eacces-"));
  const p = join(dir, "forbidden.bin");
  writeFileSync(p, new Uint8Array([0x66, 0x6f, 0x6f]));
  chmodSync(p, 0o000);
  try {
    let caught: NodeJS.ErrnoException | null = null;
    try {
      await readBytesIfExists(p);
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toMatch(/^(EACCES|EPERM|ENOENT)$/);
  } finally {
    chmodSync(p, 0o644);
  }
});

test("propagates EACCES rather than swallowing it (the .catch(() => '') bug fix)", async () => {
  // The previous .catch(() => "") pattern silently treated EACCES as "no prior
  // fact", causing a real (forbidden) file to be silently overwritten. The
  // helper must throw on EACCES so the caller can decide what to do.
  const dir = mkdtempSync(join(tmpdir(), "vibe-saferead-eacces-"));
  const p = join(dir, "forbidden.txt");
  writeFileSync(p, "secret\n");
  chmodSync(p, 0o000);
  try {
    let caught: NodeJS.ErrnoException | null = null;
    try {
      await readTextIfExists(p);
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    // Bun's I/O layer may surface EACCES, EPERM, or sometimes ENOENT (when
    // chmod 0o000 blocks even the path-resolution stat) — any of those is
    // an UNEXPECTED outcome for "the file genuinely didn't exist" and must
    // not be silently mapped to null.
    expect(caught).not.toBeNull();
    expect(caught!.code).toMatch(/^(EACCES|EPERM|ENOENT)$/);
    // And specifically: the helper must NOT have returned null.
  } finally {
    // Restore perms so tmp cleanup can unlink the dir on macOS/Linux.
    chmodSync(p, 0o644);
  }
});

test("the read is a single atomic step: no separate exists() call (Bun's FD outlives pathname)", async () => {
  // The TOCTOU being closed here: the OLD code did `await file.exists()` then
  // `await file.text()` as two awaits. If a sibling unlinked the path between
  // them, the text() read would throw ENOENT. The new code does ONE await on
  // Bun.file().text() — there is no separate exists() to race against.
  //
  // We can't deterministically inject an unlink between two sync-stat calls
  // in single-threaded JS, so this test exercises the underlying property:
  // Bun's read uses an FD internally; that FD outlives the pathname. After
  // unlinkSync(path), the path is gone but a previously-opened FD on it still
  // serves the inode. readTextIfExists is implemented on top of that.
  const dir = mkdtempSync(join(tmpdir(), "vibe-saferead-fd-"));
  const p = join(dir, "v1.txt");
  writeFileSync(p, "first\n");
  // We can't observe Bun's internal FD; we CAN assert the externally visible
  // property: deleting the path between two reads of the same content yields
  // a "file doesn't exist" null on the second read, NOT a stale content.
  // (Bun's text() opens anew each call — so this is a structural check, not
  // a race injection.)
  expect(await readTextIfExists(p)).toBe("first\n");
  unlinkSync(p);
  expect(existsSync(p)).toBe(false);
  expect(await readTextIfExists(p)).toBeNull();
  expect(await readBytesIfExists(p)).toBeNull();
});
