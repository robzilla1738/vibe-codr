import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statResolve, normalizeSpaces } from "./stat-resolve.ts";

test("normalizeSpaces replaces U+202F and U+00A0 with regular spaces", () => {
  expect(normalizeSpaces("hello\u202Fworld")).toBe("hello world");
  expect(normalizeSpaces("foo\u00A0bar")).toBe("foo bar");
  expect(normalizeSpaces("a\u2009b\u200Ac")).toBe("a b c");
  expect(normalizeSpaces("no-spaces")).toBe("no-spaces");
});

test("statResolve finds a file directly when the path matches exactly", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-statresolve-"));
  writeFileSync(join(cwd, "test.txt"), "hello");
  const r = await statResolve(join(cwd, "test.txt"));
  expect(r).not.toBeNull();
  expect(r?.actualPath).toBe(join(cwd, "test.txt"));
  expect(r?.info.isFile()).toBe(true);
});

test("statResolve returns null for a non-existent file with no spaces in basename", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-statresolve-"));
  const r = await statResolve(join(cwd, "nope.txt"));
  expect(r).toBeNull();
});

test("statResolve finds a macOS screenshot with U+202F via parent-dir fallback", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-statresolve-unicode-"));
  // Create a file with U+202F (NARROW NO-BREAK SPACE) before PM
  const realName = "Screenshot 2026-07-12 at 12.32.50\u202FPM.png";
  writeFileSync(join(cwd, realName), "fake-png");
  // User types the path with regular spaces
  const typedPath = join(cwd, "Screenshot 2026-07-12 at 12.32.50 PM.png");
  const r = await statResolve(typedPath);
  expect(r).not.toBeNull();
  expect(r?.info.isFile()).toBe(true);
  expect(r?.actualPath).toBe(join(cwd, realName));
});

test("statResolve returns null when no fuzzy match exists in the directory", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-statresolve-nomatch-"));
  writeFileSync(join(cwd, "other.txt"), "data");
  const r = await statResolve(join(cwd, "missing file.txt"));
  expect(r).toBeNull();
});
