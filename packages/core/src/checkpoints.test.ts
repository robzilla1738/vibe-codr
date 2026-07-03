import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointManager } from "./checkpoints.ts";
import { gitAddWorktree } from "./build/gitops.ts";

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

test("one undo reverts the turn even when a green result-marker sits on top", async () => {
  // Mirrors the real edit turn: a pre-edit snapshot, then the model edits, then
  // commit-on-green pushes a GREEN checkpoint of the post-edit tree. `/undo` must
  // revert to the PRE-EDIT state in a single call, not land on the (no-op) green
  // marker and force a second press.
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  const preedit = await cp.snapshot("edit auth.ts"); // pre-edit baseline
  await Bun.write(join(dir, "a.txt"), "EDITED BY AGENT\n"); // the turn's edit
  await cp.snapshot("green: edit auth.ts", undefined, { green: true }); // post-edit green marker

  const restored = await cp.undo();
  // Restored the pre-edit checkpoint, not the green marker…
  expect(restored?.id).toBe(preedit!.id);
  // …and the file is actually back to its pre-edit content after ONE undo.
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("original\n");
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

test("diffFrom does not surface the engine's .vibe/ worktree state once excluded", async () => {
  // A nested worktree under .vibe/ would otherwise be staged by diffFrom's
  // throwaway `git add -A` as an embedded-repo gitlink and burn review budget on
  // a phantom change. gitAddWorktree writes .vibe/ to the local exclude, so the
  // green-gate reviewer's diff must stay clean.
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  const base = await cp.snapshot("base");
  expect(base).not.toBeNull();

  const wtPath = join(dir, ".vibe", "worktrees", "w1");
  const wt = await gitAddWorktree(dir, { path: wtPath, branch: "vibe-wt/cp" });
  expect(wt).toBe(wtPath);

  // A real change the reviewer SHOULD see, plus the .vibe/ runtime state it should NOT.
  await Bun.write(join(dir, "real.txt"), "user change\n");
  const diff = await cp.diffFrom(base!.id);
  expect(diff).toContain("real.txt");
  expect(diff).not.toContain(".vibe");
});

test("non-git directories are a safe no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-nogit-"));
  const cp = new CheckpointManager(dir);
  expect(await cp.isGitRepo()).toBe(false);
  expect(await cp.snapshot("x")).toBeNull();
  expect(await cp.undo()).toBeNull();
  expect(await cp.diffFrom(undefined)).toBe("");
});

test("snapshot persists green + gate meta (back-compat: old entries lack them)", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  const gate = {
    outcome: "green" as const,
    round: 0,
    checks: [
      { check: "test" as const, command: "bun test", pass: true, failed: 0, total: 3, firstFailures: [], durationMs: 5 },
    ],
  };
  await cp.snapshot("green: test ✓ 3/3", undefined, { green: true, gate });

  // A fresh manager reads the persisted meta from disk (what the engine's tests do).
  const fresh = await new CheckpointManager(dir).list();
  const greenCp = fresh.find((c) => c.green);
  expect(greenCp).toBeDefined();
  expect(greenCp!.label).toBe("green: test ✓ 3/3");
  expect(greenCp!.gate?.outcome).toBe("green");
});

test("diffFrom returns a hunk of the working tree vs a checkpoint (incl. new files)", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  const base = await cp.snapshot("base");
  expect(base).not.toBeNull();

  // Modify a tracked file and create a brand-new untracked one.
  await Bun.write(join(dir, "a.txt"), "CHANGED LINE\n");
  await Bun.write(join(dir, "brand-new.ts"), "export const added = 1;\n");

  const diff = await cp.diffFrom(base!.id);
  expect(diff).toContain("a.txt");
  expect(diff).toContain("CHANGED LINE");
  // A plain `git diff <commit>` would omit the untracked file; the throwaway-index
  // staging in diffFrom means added files show up too.
  expect(diff).toContain("brand-new.ts");
  expect(diff).toContain("export const added = 1;");

  // The user's real index is untouched (a.txt shows as modified-but-unstaged).
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: dir, stdout: "pipe" });
  const status = await new Response(proc.stdout).text();
  await proc.exited;
  expect(status).toContain(" M a.txt");
});

test("diffFrom caps a giant diff with a truncation marker", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  const base = await cp.snapshot("base");
  await Bun.write(join(dir, "huge.txt"), `${"x".repeat(50_000)}\n`);

  const diff = await cp.diffFrom(base!.id, { max: 2_000 });
  expect(diff).toContain("diff truncated at 2000 chars");
  expect(diff.length).toBeLessThan(2_100);
});

test("two managers on one repo merge checkpoints instead of clobbering (and write atomically)", async () => {
  // checkpoints.json is cwd-keyed → shared by every session in one repo. A bare
  // overwrite would drop the other manager's entries; the merge-by-id keeps both.
  const dir = await initRepo();
  const a = new CheckpointManager(dir);
  const b = new CheckpointManager(dir);
  // A snapshots first (writes the file), then B snapshots (must MERGE, not clobber A).
  const snapA = await a.snapshot("A-checkpoint");
  const snapB = await b.snapshot("B-checkpoint");
  expect(snapA).not.toBeNull();
  expect(snapB).not.toBeNull();

  // A fresh manager reads the persisted file — both checkpoints must be present.
  const fresh = new CheckpointManager(dir);
  const ids = (await fresh.list()).map((c) => c.id);
  expect(ids).toContain(snapA!.id);
  expect(ids).toContain(snapB!.id);
  // No temp file left behind (atomic rename cleaned up).
  const { readdirSync } = await import("node:fs");
  const { globalStateDir } = await import("./state-dir.ts");
  const files = readdirSync(globalStateDir(dir));
  expect(files.some((f) => f.startsWith("checkpoints.json.") && f.endsWith(".tmp"))).toBe(false);
});

test("/undo restores THIS session's checkpoint, never a concurrent session's (no #list pollution)", async () => {
  // The merge fold is disk-only: it must NOT leak another session's entries into
  // this session's in-memory list, or undo would revert to the OTHER session's
  // (uncommitted) work instead of this session's own safety snapshot.
  const dir = await initRepo();
  const A = new CheckpointManager(dir);
  const B = new CheckpointManager(dir);

  await Bun.write(join(dir, "a.txt"), "A-original\n");
  await A.snapshot("A-safety"); // A's own pre-edit safety net (captures A-original)

  await Bun.write(join(dir, "a.txt"), "B-modified\n");
  await B.snapshot("B-work"); // another session's checkpoint → disk now has both

  await Bun.write(join(dir, "a.txt"), "A-more\n");
  await A.snapshot("A-green", undefined, { green: true }); // A saves again (re-reads disk)

  // ONE /undo from A: skip its green marker, restore A's OWN pre-edit — a.txt must
  // be A-original, NOT B-modified (which the pre-fix #list pollution would restore).
  const restored = await A.undo();
  expect(restored?.label).toBe("A-safety");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("A-original\n");
});

test("a resumed manager's /undo is scoped to ITS session, not others in the shared file", async () => {
  // The cwd-keyed checkpoints.json accumulates every session's entries. A fresh
  // (resumed) manager for session A must load only A's checkpoints, so /undo
  // reverts A's own work — not session B's — after a restart.
  const dir = await initRepo();
  const A1 = new CheckpointManager(dir, () => "sesA");
  const B1 = new CheckpointManager(dir, () => "sesB");
  await Bun.write(join(dir, "a.txt"), "A-original\n");
  await A1.snapshot("A-safety"); // sesA, captures A-original
  await Bun.write(join(dir, "a.txt"), "B-work\n");
  await B1.snapshot("B-work"); // sesB, more recent, on disk with A's

  await Bun.write(join(dir, "a.txt"), "current\n");
  // Simulate a restart: a FRESH manager for sesA reads the shared file.
  const A2 = new CheckpointManager(dir, () => "sesA");
  const restored = await A2.undo();
  expect(restored?.label).toBe("A-safety"); // A's own, not B-work
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("A-original\n");
});
