import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointManager } from "./checkpoints.ts";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "vibe-cp-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "t@t.dev"]);
  await git(dir, ["config", "user.name", "t"]);
  await Bun.write(join(dir, "a.txt"), "original\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "init"]);
  return dir;
}

test("snapshot + undo restores modified, created, and deleted files", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);

  // Take a checkpoint of the committed state, then make a mess.
  const snap = await cp.snapshot("before edits");
  expect(snap).not.toBeNull();

  await Bun.write(join(dir, "a.txt"), "MODIFIED\n"); // modify tracked
  await Bun.write(join(dir, "b.txt"), "new file\n"); // create untracked
  await Bun.write(join(dir, "nested/c.txt"), "deep\n"); // create in new dir

  const restored = await cp.undo();
  expect(restored?.label).toBe("before edits");

  // a.txt is back to the snapshot content; b.txt and nested/ are gone.
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("original\n");
  expect(await Bun.file(join(dir, "b.txt")).exists()).toBe(false);
  expect(await Bun.file(join(dir, "nested/c.txt")).exists()).toBe(false);
});

test("the user's staging area is left untouched after a snapshot", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  await Bun.write(join(dir, "a.txt"), "changed\n");
  await cp.snapshot("mid");

  // `git status --porcelain` should show a.txt modified-but-unstaged (" M"),
  // i.e. the snapshot didn't leave everything staged. (Do not trim — the
  // leading space is part of git's two-char XY status code.)
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: dir, stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).toContain(" M a.txt");
});

test("non-git directories are a safe no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-nogit-"));
  const cp = new CheckpointManager(dir);
  expect(await cp.isGitRepo()).toBe(false);
  expect(await cp.snapshot("x")).toBeNull();
  expect(await cp.undo()).toBeNull();
});
