import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalStateDir, ensureStateDir, ensureVibeIgnored } from "./state-dir.ts";

process.env.VIBE_STATE_DIR ??= mkdtempSync(join(tmpdir(), "vibe-state-"));

test("globalStateDir is stable per cwd and distinct across cwds", () => {
  const a = mkdtempSync(join(tmpdir(), "vibe-sd-a-"));
  const b = mkdtempSync(join(tmpdir(), "vibe-sd-b-"));
  expect(globalStateDir(a)).toBe(globalStateDir(a));
  expect(globalStateDir(a)).not.toBe(globalStateDir(b));
  expect(globalStateDir(a).startsWith(process.env.VIBE_STATE_DIR!)).toBe(true);
});

test("ensureStateDir creates the dir with a reverse-lookup path file", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-sd-ensure-"));
  const dir = await ensureStateDir(cwd);
  expect(readFileSync(join(dir, "path"), "utf8").trim().endsWith(cwd.split("/").pop()!)).toBe(true);
});

test("ensureVibeIgnored appends .vibe/ once, only in a git repo", async () => {
  const repo = mkdtempSync(join(tmpdir(), "vibe-sd-git-"));
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");

  await ensureVibeIgnored(repo);
  expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("node_modules\n.vibe/\n");
  // Idempotent — a second call appends nothing.
  await ensureVibeIgnored(repo);
  expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("node_modules\n.vibe/\n");

  // Not a git repo → untouched (no .gitignore created).
  const plain = mkdtempSync(join(tmpdir(), "vibe-sd-plain-"));
  await ensureVibeIgnored(plain);
  expect(await Bun.file(join(plain, ".gitignore")).exists()).toBe(false);
});

test("ensureVibeIgnored creates .gitignore when absent and respects existing entries", async () => {
  const repo = mkdtempSync(join(tmpdir(), "vibe-sd-git2-"));
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await ensureVibeIgnored(repo);
  expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(".vibe/\n");

  const repo2 = mkdtempSync(join(tmpdir(), "vibe-sd-git3-"));
  mkdirSync(join(repo2, ".git"));
  writeFileSync(join(repo2, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repo2, ".gitignore"), "/.vibe/\n"); // already covered, different spelling
  await ensureVibeIgnored(repo2);
  expect(readFileSync(join(repo2, ".gitignore"), "utf8")).toBe("/.vibe/\n");
});
