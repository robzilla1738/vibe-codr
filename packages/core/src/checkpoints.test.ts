import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointManager } from "./checkpoints.ts";
import { gitAddWorktree } from "./build/gitops.ts";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

/** git invocation that returns trimmed stdout (for asserting on ref state). */
async function gitOut(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

/** The ids of the live hidden checkpoint refs (`refs/vibecodr/<id>`). */
async function vibeRefIds(dir: string): Promise<string[]> {
  const out = await gitOut(dir, ["for-each-ref", "--format=%(refname)", "refs/vibecodr/"]);
  return out
    .split("\n")
    .map((r) => r.trim().replace("refs/vibecodr/", ""))
    .filter(Boolean);
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
  // `git gc --prune=now` can exceed the 5s default under full-suite load.
}, 30_000);

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
  // `git gc --prune=now` can exceed the 5s default under full-suite load.
}, 30_000);

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
      {
        check: "test" as const,
        command: "bun test",
        pass: true,
        failed: 0,
        total: 3,
        firstFailures: [],
        durationMs: 5,
      },
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
  expect(existsSync(join(globalStateDir(dir), "checkpoints.json.lock"))).toBe(false);
});

test("checkpoint metadata save clears a stale cross-process lock", async () => {
  const dir = await initRepo();
  const { globalStateDir } = await import("./state-dir.ts");
  const state = globalStateDir(dir);
  mkdirSync(join(state, "checkpoints.json.lock"), { recursive: true });
  const stale = new Date(Date.now() - 120_000);
  utimesSync(join(state, "checkpoints.json.lock"), stale, stale);

  const cp = new CheckpointManager(dir);
  const snap = await cp.snapshot("after-stale-lock");
  expect(snap).not.toBeNull();
  expect(existsSync(join(state, "checkpoints.json.lock"))).toBe(false);
});

test("checkpoint metadata save steals a dead-process lock immediately via PID liveness check", async () => {
  const dir = await initRepo();
  const { globalStateDir } = await import("./state-dir.ts");
  const { writeFileSync } = await import("node:fs");
  const state = globalStateDir(dir);
  const lockDir = join(state, "checkpoints.json.lock");
  mkdirSync(lockDir, { recursive: true });
  // Write an owner file with a PID that is almost certainly dead (max PID + 1
  // on any real system). The PID-based liveness check must steal this lock
  // immediately, without waiting for the 60s stale timeout.
  writeFileSync(join(lockDir, "owner"), `999999\n${Date.now()}\n`, "utf8");

  const cp = new CheckpointManager(dir);
  const snap = await cp.snapshot("after-dead-pid-lock");
  expect(snap).not.toBeNull();
  expect(existsSync(lockDir)).toBe(false);
});

test("checkpoint metadata save waits for a live-process lock (PID is alive)", async () => {
  const dir = await initRepo();
  const { globalStateDir } = await import("./state-dir.ts");
  const { writeFileSync, rmSync } = await import("node:fs");
  const state = globalStateDir(dir);
  const lockDir = join(state, "checkpoints.json.lock");
  mkdirSync(lockDir, { recursive: true });
  // Write an owner file with OUR OWN PID — the liveness check will see it as
  // alive, so the lock must NOT be stolen. The snapshot should wait, then
  // eventually succeed once we clean up the lock ourselves (simulating the
  // owner releasing). We pre-clean the lock in a setTimeout to avoid a hang.
  writeFileSync(join(lockDir, "owner"), `${process.pid}\n${Date.now()}\n`, "utf8");
  setTimeout(() => rmSync(lockDir, { recursive: true, force: true }), 100);

  const cp = new CheckpointManager(dir);
  const snap = await cp.snapshot("after-live-pid-lock");
  expect(snap).not.toBeNull();
  expect(existsSync(lockDir)).toBe(false);
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

test("restoreTo lands the tree on the chosen checkpoint and stacks the newer ones as redos", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);

  await Bun.write(join(dir, "a.txt"), "v0\n");
  const c0 = await cp.snapshot("v0");
  await Bun.write(join(dir, "a.txt"), "v1\n");
  await cp.snapshot("v1");
  await Bun.write(join(dir, "a.txt"), "v2\n");
  await cp.snapshot("v2");
  await Bun.write(join(dir, "a.txt"), "v3\n");
  await cp.snapshot("v3");

  // Rewind three steps at once, straight back to c0.
  const target = await cp.restoreTo(c0!.id);
  expect(target?.label).toBe("v0");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v0\n");
  // Three newer checkpoints are now on the redo stack.
  expect(cp.redoDepth()).toBe(3);

  // Redo walks forward one step at a time (closest-to-target first).
  expect((await cp.redo())?.label).toBe("v1");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v1\n");
  expect((await cp.redo())?.label).toBe("v2");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v2\n");
  expect((await cp.redo())?.label).toBe("v3");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v3\n");
  // Stack drained → nothing to redo.
  expect(cp.redoDepth()).toBe(0);
  expect(await cp.redo()).toBeNull();
});

test("restoreTo removes files created after the target (like undo)", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  await Bun.write(join(dir, "a.txt"), "base\n");
  const base = await cp.snapshot("base");
  // A later turn adds a file and takes another checkpoint.
  await Bun.write(join(dir, "added-later.txt"), "later\n");
  await cp.snapshot("later");

  await cp.restoreTo(base!.id);
  // The file created after the target is gone; a.txt is back to the target tree.
  expect(await Bun.file(join(dir, "added-later.txt")).exists()).toBe(false);
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("base\n");
});

test("redo after one undo restores the pre-undo tree byte-for-byte", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);

  // Real turn shape: a pre-edit snapshot, the model edits, a green result marker.
  await cp.snapshot("edit"); // a.txt == "original\n"
  await Bun.write(join(dir, "a.txt"), "EDITED\n");
  await Bun.write(join(dir, "extra.bin"), "\u0000byte\u00ff\n"); // a newly-created file too
  await cp.snapshot("green: edit", undefined, { green: true });

  const undone = await cp.undo();
  expect(undone?.label).toBe("edit");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("original\n");
  expect(await Bun.file(join(dir, "extra.bin")).exists()).toBe(false);

  // Redo must restore the exact pre-undo working tree — content AND the new file.
  const re = await cp.redo();
  expect(re).not.toBeNull();
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("EDITED\n");
  expect(await Bun.file(join(dir, "extra.bin")).text()).toBe("\u0000byte\u00ff\n");
});

test("undo stashes an opaque payload that redo hands back when it restores the pre-undo state", async () => {
  // FIX 1: /undo captures the sliced-off conversation tail and pins it to the redo
  // step; /redo must return it so the caller can move the model context forward in
  // lockstep with the files. The manager treats the payload as opaque.
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  await cp.snapshot("edit"); // pre-edit safety snapshot
  await Bun.write(join(dir, "a.txt"), "edited\n");
  await cp.snapshot("green: edit", undefined, { green: true });

  const undone = await cp.undo();
  expect(undone?.label).toBe("edit");
  const tail = { marker: "conversation-tail" };
  cp.stashRedoPayload(tail);

  const re = await cp.redo();
  expect(re?.payload).toBe(tail); // returned byte-for-byte, same reference
});

test("restoreTo pins the conversation payload to the topmost step so only the FULL forward walk restores it", async () => {
  // FIX 1+2 coordination: the multi-step rewind stashes the tail on the phantom
  // (pre-rewind) step, so intermediate redos leave it alone and only the final step
  // — landing back on the original working tree — hands it back.
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  await Bun.write(join(dir, "a.txt"), "v1\n");
  const c1 = await cp.snapshot("v1");
  await Bun.write(join(dir, "a.txt"), "v2\n");
  await cp.snapshot("v2");
  await Bun.write(join(dir, "a.txt"), "S\n"); // uncommitted edits above the newest cp

  await cp.restoreTo(c1!.id);
  const tail = { marker: "multi-step-tail" };
  cp.stashRedoPayload(tail);

  const step1 = await cp.redo(); // → v2 (mid-walk, no payload yet)
  expect(step1?.label).toBe("v2");
  expect(step1?.payload).toBeUndefined();

  const step2 = await cp.redo(); // → S (the pre-rewind tree) — payload handed back
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("S\n");
  expect(step2?.payload).toBe(tail);
  expect(cp.redoDepth()).toBe(0);
});

test("restoreTo to the newest checkpoint after a NO-EDIT turn still leaves a redo step for the tail", async () => {
  // Deferred sweep item: `/undo <n>` targeting the NEWEST checkpoint when the
  // turn after it made no file edits (working tree == the target's snapshot)
  // skipped the phantom step as "identical tree" — but with no newer checkpoints
  // there was NO other step to carry the conversation tail the caller stashes
  // right after, so stashRedoPayload no-op'd and the rewound context was
  // unrecoverable (/redo: nothing to redo). The phantom must survive whenever it
  // is the only possible redo step; redoing it is a file no-op that hands the
  // tail back.
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  await Bun.write(join(dir, "a.txt"), "v1\n");
  await cp.snapshot("v1");
  await Bun.write(join(dir, "a.txt"), "v2\n");
  const c2 = await cp.snapshot("v2");
  // The turn after v2 only talked — the tree still matches v2's snapshot.

  const target = await cp.restoreTo(c2!.id);
  expect(target?.label).toBe("v2");
  const tail = { marker: "no-edit-tail" };
  cp.stashRedoPayload(tail);

  expect(cp.redoDepth()).toBe(1); // the pre-rewind capture — the tail's carrier
  const re = await cp.redo();
  expect(re?.payload).toBe(tail); // handed back, not orphaned
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v2\n"); // files: no-op walk
  expect(cp.redoDepth()).toBe(0);
});

test("a new edit-checkpoint clears the redo stack", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  await cp.snapshot("t1");
  await Bun.write(join(dir, "a.txt"), "edited\n");
  await cp.snapshot("green: t1", undefined, { green: true });

  await cp.undo();
  expect(cp.redoDepth()).toBe(1); // one step available

  // A fresh edit-checkpoint invalidates the redo line.
  await Bun.write(join(dir, "a.txt"), "brand new work\n");
  await cp.snapshot("t2");
  expect(cp.redoDepth()).toBe(0);
  expect(await cp.redo()).toBeNull();
});

test("restoreTo holds the dead-commit guard: a gone snapshot is a no-op, not a wipe", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  await Bun.write(join(dir, "precious.txt"), "irreplaceable\n"); // untracked user work
  const snap = await cp.snapshot("before");

  // Garbage-collect the snapshot commit so read-tree/ls-tree fail with empty output.
  await git(dir, ["update-ref", "-d", `refs/vibecodr/${snap!.id}`]);
  await git(dir, ["reflog", "expire", "--expire=now", "--all"]);
  await git(dir, ["gc", "--prune=now"]);

  const restored = await cp.restoreTo(snap!.id);
  expect(restored).toBeNull(); // refused, not a partial restore
  expect(cp.redoDepth()).toBe(0); // nothing moved onto the redo stack
  expect(await Bun.file(join(dir, "precious.txt")).exists()).toBe(true); // untracked file survives
  // `git gc --prune=now` can exceed the 5s default under full-suite load.
}, 30_000);

test("restoreTo + redo-to-exhaustion lands byte-for-byte on the pre-rewind working tree (newest edits above the top checkpoint are recoverable)", async () => {
  // Regression: restoreTo did not capture the CURRENT working tree, so after a
  // multi-step rewind, redoing forward topped out one state short — the newest
  // edits (which sit ABOVE the newest checkpoint) were unrecoverable.
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);

  await Bun.write(join(dir, "a.txt"), "v1\n");
  const c1 = await cp.snapshot("v1");
  await Bun.write(join(dir, "a.txt"), "v2\n");
  await cp.snapshot("v2");
  await Bun.write(join(dir, "a.txt"), "v3\n");
  await cp.snapshot("v3");
  // Edits made AFTER the newest checkpoint — the working tree (S3) sits above v3.
  await Bun.write(join(dir, "a.txt"), "S3\n");
  await Bun.write(join(dir, "fresh.txt"), "newest\n");

  const target = await cp.restoreTo(c1!.id);
  expect(target?.label).toBe("v1");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v1\n");
  expect(await Bun.file(join(dir, "fresh.txt")).exists()).toBe(false);
  // v2, v3, and the phantom step back to S3 → three forward steps, not two.
  expect(cp.redoDepth()).toBe(3);

  while (cp.redoDepth() > 0) await cp.redo();

  // Byte-for-byte back at S3: the newest uncommitted edits are NOT lost.
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("S3\n");
  expect(await Bun.file(join(dir, "fresh.txt")).text()).toBe("newest\n");
});

test("restoreTo releases its owned refs when a new snapshot clears the redo stack (no ref leak)", async () => {
  const dir = await initRepo();
  const cp = new CheckpointManager(dir);
  await Bun.write(join(dir, "a.txt"), "v1\n");
  const c1 = await cp.snapshot("v1");
  await Bun.write(join(dir, "a.txt"), "v2\n");
  const c2 = await cp.snapshot("v2");
  await Bun.write(join(dir, "a.txt"), "S\n"); // uncommitted edits above v2

  await cp.restoreTo(c1!.id);
  expect(cp.redoDepth()).toBe(2); // v2 + the phantom capture of S

  // A fresh edit-checkpoint invalidates the redo line; every ref it owned — the
  // stacked v2 checkpoint AND the throwaway phantom capture — must be deleted.
  await Bun.write(join(dir, "a.txt"), "brand new\n");
  const c3 = await cp.snapshot("v3");
  expect(cp.redoDepth()).toBe(0);
  expect(await cp.redo()).toBeNull();

  // Only the live checkpoints remain (v1, v3); v2 and the phantom ref are gone.
  const refs = await vibeRefIds(dir);
  expect(refs.sort()).toEqual([c1!.id, c3!.id].sort());
  expect(refs).not.toContain(c2!.id);
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

test("restore from a repo SUBDIRECTORY reverts the whole tree, not just the subtree", async () => {
  // Regression: checkout-index / ls-files --others are cwd-prefix scoped, so a
  // manager rooted at repo/sub used to restore only sub/* while the engine
  // rewound the conversation for the whole turn.
  const dir = await initRepo();
  await Bun.write(join(dir, "sub/inner.txt"), "v0\n");
  await Bun.write(join(dir, "root.txt"), "root-v0\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "add files"]);

  const cp = new CheckpointManager(join(dir, "sub")); // session runs in the subdir
  const snap = await cp.snapshot("before edits");
  expect(snap).not.toBeNull();

  // Edit BOTH a file in the subdir and a file at the repo root, plus an
  // untracked file above the subdir.
  await Bun.write(join(dir, "sub/inner.txt"), "v1\n");
  await Bun.write(join(dir, "root.txt"), "root-v1\n");
  await Bun.write(join(dir, "created-root.txt"), "new\n");

  await cp.undo();

  // Every path is reverted — including the ones OUTSIDE the session's subdir.
  expect(await Bun.file(join(dir, "sub/inner.txt")).text()).toBe("v0\n");
  expect(await Bun.file(join(dir, "root.txt")).text()).toBe("root-v0\n");
  expect(await Bun.file(join(dir, "created-root.txt")).exists()).toBe(false);
});

test("restart after restoreTo: a fresh manager's /undo does not resurrect rewound edits", async () => {
  // Regression: the disk merge re-added this-session entries that restoreTo had
  // removed, so after a restart a bare /undo moved the tree FORWARD.
  const dir = await initRepo();
  const sid = () => "sess-restart";
  const cp = new CheckpointManager(dir, sid);
  const v1 = await cp.snapshot("v1");
  await Bun.write(join(dir, "a.txt"), "v1-edit\n");
  await cp.snapshot("v2");
  await Bun.write(join(dir, "a.txt"), "v2-edit\n");
  await cp.snapshot("v3");

  // Rewind all the way back to v1's tree (v2/v3 popped from #list).
  await cp.restoreTo(v1!.id);
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("original\n");

  // Simulate a restart: a fresh manager for the SAME session id reloads from
  // disk (the redo stack is legitimately gone). A bare /undo must not exist —
  // there is no checkpoint newer than the current tree to move toward.
  const cp2 = new CheckpointManager(dir, sid);
  const list = await cp2.list();
  // The popped v2/v3 are not resurrected as live entries.
  expect(list.map((c) => c.label).sort()).toEqual(["v1"]);
  await Bun.write(join(dir, "a.txt"), "post-restart\n");
  const undone = await cp2.undo();
  // /undo rewinds to v1 (the only checkpoint), never forward to v2/v3's edits.
  expect(undone?.label).toBe("v1");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("original\n");
});
