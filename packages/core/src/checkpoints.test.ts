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

test("snapshot in a repo with no commits leaves the index empty", async () => {
  // A freshly `git init`'d repo has no HEAD; the snapshot must not leave the
  // working tree staged in the user's index.
  const dir = mkdtempSync(join(tmpdir(), "vibe-cp-fresh-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "t@t.dev"]);
  await git(dir, ["config", "user.name", "t"]);
  await Bun.write(join(dir, "a.txt"), "hello\n");

  const cp = new CheckpointManager(dir);
  const snap = await cp.snapshot("first");
  expect(snap).not.toBeNull();

  // a.txt should still be untracked ("??"), not staged ("A ").
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: dir, stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).toContain("?? a.txt");
  expect(out).not.toContain("A  a.txt");
});

test("undo preserves the user's pre-existing untracked files and staged changes", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);

  // The user already has an untracked file and a staged change before the agent runs.
  await Bun.write(join(dir, "user-notes.txt"), "my notes\n");
  await Bun.write(join(dir, "a.txt"), "user staged\n");
  await git(dir, ["add", "a.txt"]);

  const snap = await cp.snapshot("before agent edits");
  expect(snap).not.toBeNull();

  // The agent then edits a tracked file and creates a new one.
  await Bun.write(join(dir, "a.txt"), "AGENT EDIT\n");
  await Bun.write(join(dir, "agent-new.txt"), "agent created\n");

  await cp.undo();

  // The agent's new file is removed; the user's untracked file SURVIVES.
  expect(await Bun.file(join(dir, "agent-new.txt")).exists()).toBe(false);
  expect(await Bun.file(join(dir, "user-notes.txt")).exists()).toBe(true);
  // a.txt is restored to the snapshot (the user's staged content at snapshot time).
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("user staged\n");
});

test("a checkpoint records the conversation mark for history rollback", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  const snap = await cp.snapshot("turn", { messages: 4, history: 3 });
  expect(snap!.conversation).toEqual({ messages: 4, history: 3 });
  const restored = await cp.undo();
  expect(restored!.conversation).toEqual({ messages: 4, history: 3 });
});

test("undo with a missing snapshot commit refuses to delete untracked files", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);

  // The user has untracked work before the agent touches anything.
  await Bun.write(join(dir, "precious.txt"), "irreplaceable\n");

  const snap = await cp.snapshot("before");
  expect(snap).not.toBeNull();

  // Simulate the snapshot commit being garbage-collected / lost: delete its ref
  // and prune the object so read-tree/ls-tree fail with empty output.
  await git(dir, ["update-ref", "-d", `refs/vibecodr/${snap!.id}`]);
  await git(dir, ["reflog", "expire", "--expire=now", "--all"]);
  await git(dir, ["gc", "--prune=now"]);

  const restored = await cp.undo();
  // Undo could not restore (commit gone) — but it must NOT have deleted the
  // user's untracked file (the old code wiped ALL untracked on a false-empty tree).
  expect(restored).toBeNull();
  expect(await Bun.file(join(dir, "precious.txt")).exists()).toBe(true);
});

test("undo advances past a dead checkpoint to the next valid one", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);

  // Two checkpoints: an older valid one, then a newer one we'll make dead.
  await Bun.write(join(dir, "a.txt"), "v1\n");
  await cp.snapshot("older-valid");
  await Bun.write(join(dir, "a.txt"), "v2\n");
  const newer = await cp.snapshot("newer-will-die");

  // Kill only the NEWER checkpoint's commit object.
  await git(dir, ["update-ref", "-d", `refs/vibecodr/${newer!.id}`]);
  await git(dir, ["reflog", "expire", "--expire=now", "--all"]);
  await git(dir, ["gc", "--prune=now"]);

  // Current working state, then undo: it must skip the dead newer checkpoint and
  // restore the older valid one (not report "nothing to undo").
  await Bun.write(join(dir, "a.txt"), "v3-dirty\n");
  const restored = await cp.undo();
  expect(restored?.label).toBe("older-valid");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v1\n");
});

test("non-git directories are a safe no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-nogit-"));
  const cp = new CheckpointManager(dir);
  expect(await cp.isGitRepo()).toBe(false);
  expect(await cp.snapshot("x")).toBeNull();
  expect(await cp.undo()).toBeNull();
});
