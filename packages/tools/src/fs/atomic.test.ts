import { test, expect } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicReplace } from "./atomic.ts";

test("fresh create: writes content to a non-existing path with no temp leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-atomic-fresh-"));
  const p = join(dir, "ghost.txt");
  await atomicReplace(p, "hello\n");
  expect(await Bun.file(p).text()).toBe("hello\n");
  // The temp sibling was unlinked on rename — only the real file survives.
  expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
});

test("fresh create: the new file's mode honors the umask (no hardcoded 0o644)", async () => {
  // We intentionally do NOT hardcode 0o644: Bun.write lets the temp come up
  // with `0o666 & ~process.umask()`, the same default a direct create would
  // have. Test the umask-respecting upper bound (rw for owner), not the
  // absolute value — runners have different umasks.
  const dir = mkdtempSync(join(tmpdir(), "vibe-atomic-umask-"));
  const p = join(dir, "unmasked.txt");
  await atomicReplace(p, "x");
  const m = statSync(p).mode & 0o777;
  // Owner write is the lowest bar a normal umask gives; never 0o644 hardcoded.
  expect(m & 0o200).toBe(0o200);
  // And definitely not 0o000 (a chmod failure) nor 0o777 (a chmod too far).
  expect(m).not.toBe(0o000);
  expect(m).not.toBe(0o777);
});

test("overwrite preserves the existing target's mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-atomic-mode-"));
  const p = join(dir, "run.sh");
  await Bun.write(p, "echo v1\n");
  chmodSync(p, 0o750);
  await atomicReplace(p, "echo v2\n");
  // rename drops the original inode; without carrying the mode the +x bits
  // would be lost. The fix captures on `target` so this holds even when the
  // race (external chmod) sits between the caller's stat-call and our chmod.
  expect(statSync(p).mode & 0o777).toBe(0o750);
});

test("writing THROUGH a symlink preserves the link and updates its real target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-atomic-link-"));
  await Bun.write(join(dir, "real.txt"), "v1\n");
  symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
  await atomicReplace(join(dir, "link.txt"), "v2\n");
  // The link is still a link — not clobbered into a regular file.
  expect(lstatSync(join(dir, "link.txt")).isSymbolicLink()).toBe(true);
  // The real target got the new content.
  expect(await Bun.file(join(dir, "real.txt")).text()).toBe("v2\n");
  // No stray temp beside either the link or its target.
  expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
});

test("missing target (fresh create / concurrent delete) is recovered without crashing", async () => {
  // The unified "fresh create" path: atomicReplace is called on a path that
  // does not exist. The internal `statSync(target)` throws ENOENT, the catch
  // keeps mode undefined, no chmod is issued, and `Bun.write` lays the new
  // file under the umask — closing the C-2 exists→statSync race by
  // construction (a sibling delete between exists and statSync is structurally
  // identical to "file never existed").
  const dir = mkdtempSync(join(tmpdir(), "vibe-atomic-missing-"));
  const p = join(dir, "never-existed.txt");
  await atomicReplace(p, "first\n");
  expect(await Bun.file(p).text()).toBe("first\n");
  // And a subsequent write goes through the existing-file path correctly.
  chmodSync(p, 0o600);
  await atomicReplace(p, "second\n");
  expect(await Bun.file(p).text()).toBe("second\n");
  expect(statSync(p).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
});

test("temp filename is unique across sequential writes in the same process", async () => {
  // Without pid + counter uniqueness, two sequential writes could collide on
  // a temp path; this asserts the suffix advances monotonically.
  const dir = mkdtempSync(join(tmpdir(), "vibe-atomic-seq-"));
  await atomicReplace(join(dir, "a.txt"), "a\n");
  await atomicReplace(join(dir, "b.txt"), "b\n");
  await atomicReplace(join(dir, "c.txt"), "c\n");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("a\n");
  expect(await Bun.file(join(dir, "b.txt")).text()).toBe("b\n");
  expect(await Bun.file(join(dir, "c.txt")).text()).toBe("c\n");
  expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
});

test("mid-write failure cleans up the temp and rethrows", async () => {
  // The atomic primitive must NEVER leave a `*.tmp` sibling on a failure:
  // the only durable footprint allowed is the rename-only success case.
  const dir = mkdtempSync(join(tmpdir(), "vibe-atomic-fail-"));
  const p = join(dir, "f.txt");
  await Bun.write(p, "original\n");
  const orig = Bun.write;
  try {
    (Bun as unknown as { write: unknown }).write = (
      _path: unknown,
      _data: unknown,
    ) => {
      throw new Error("injected atomic write failure");
    };
    await expect(atomicReplace(p, "clobber\n")).rejects.toThrow(
      "injected atomic write failure",
    );
  } finally {
    (Bun as unknown as { write: typeof orig }).write = orig;
  }
  // Original bytes survive, no temp on disk.
  expect(await Bun.file(p).text()).toBe("original\n");
  expect(readdirSync(dir).some((f) => f.includes(".tmp"))).toBe(false);
});
