import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitPrepare,
  gitCommitGreen,
  gitAddWorktree,
  gitRemoveWorktree,
  gitMergeWorktreeBranch,
  gitStagedFiles,
  gitRestoreFiles,
  gitDiffSince,
  codeCacheCleanCommand,
} from "./gitops.ts";
import { spawnGit } from "../git-info.ts";

const run = (cwd: string, args: string[]) => spawnGit(cwd, args);

async function makeRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-gitops-"));
  await run(cwd, ["init", "-q", "-b", "main"]);
  await run(cwd, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "root",
  ]);
  writeFileSync(join(cwd, "a.txt"), "one\n");
  await run(cwd, ["add", "-A"]);
  await run(cwd, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "a",
  ]);
  return cwd;
}

test("gitPrepare: clean real repo → work branch; dirty real repo → refused", async () => {
  const cwd = await makeRepo();
  const ok = await gitPrepare(cwd, { branch: "vibe/test" });
  expect(ok).toEqual({ ok: true, branch: "vibe/test" });

  writeFileSync(join(cwd, "dirty.txt"), "x");
  const refused = await gitPrepare(cwd, { branch: "vibe/test2" });
  expect(refused.ok).toBe(false);
  expect(refused.reason).toContain("uncommitted");
});

test("gitPrepare: non-empty non-git dir refused; owned tree auto-inits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-gitops-nogit-"));
  writeFileSync(join(dir, "real-work.ts"), "x");
  const refused = await gitPrepare(dir, { branch: "vibe/x" });
  expect(refused.ok).toBe(false);
  expect(refused.reason).toContain("git init");

  const owned = await gitPrepare(dir, { branch: "vibe/x", ownTree: true });
  expect(owned.ok).toBe(true);
  expect(owned.branch).toBe("vibe/x");
});

test("gitCommitGreen commits staged tree with engine identity; empty tree → null", async () => {
  const cwd = await makeRepo();
  writeFileSync(join(cwd, "b.txt"), "two\n");
  const sha = await gitCommitGreen(cwd, "green: after gate");
  expect(sha).toMatch(/^[0-9a-f]{4,}$/);
  const author = await run(cwd, ["log", "-1", "--format=%an <%ae>"]);
  expect(author.stdout.trim()).toBe("vibecodr <agent@vibecodr.local>");
  // Nothing new to commit now.
  expect(await gitCommitGreen(cwd, "noop")).toBeNull();
});

test("worktree lifecycle: add → edit → squash-merge back → remove", async () => {
  const cwd = await makeRepo();
  const wtPath = join(cwd, ".vibe", "worktrees", "t1");
  mkdirSync(join(cwd, ".vibe", "worktrees"), { recursive: true });
  const wt = await gitAddWorktree(cwd, { path: wtPath, branch: "vibe-wt/t1" });
  expect(wt).toBe(wtPath);

  writeFileSync(join(wtPath, "a.txt"), "one\nedited-in-worktree\n");
  await run(wtPath, ["add", "-A"]);
  await run(wtPath, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "wt edit",
  ]);

  const changed = await gitDiffSince(cwd, "vibe-wt/t1");
  expect(changed).toContain("a.txt");

  const merged = await gitMergeWorktreeBranch(cwd, "vibe-wt/t1");
  expect(merged).toBe(true);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toContain("edited-in-worktree");

  await gitRemoveWorktree(cwd, wtPath, "vibe-wt/t1");
  const branches = await run(cwd, ["branch", "--list", "vibe-wt/t1"]);
  expect(branches.stdout.trim()).toBe("");
});

test("conflicting squash-merge is aborted cleanly and returns false", async () => {
  const cwd = await makeRepo();
  const wtPath = join(cwd, ".vibe", "worktrees", "t2");
  await gitAddWorktree(cwd, { path: wtPath, branch: "vibe-wt/t2" });

  // Diverge: same line edited in the worktree AND committed on main.
  writeFileSync(join(wtPath, "a.txt"), "worktree-version\n");
  await run(wtPath, ["add", "-A"]);
  await run(wtPath, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "wt",
  ]);
  writeFileSync(join(cwd, "a.txt"), "main-version\n");
  await run(cwd, ["add", "-A"]);
  await run(cwd, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "main",
  ]);

  const merged = await gitMergeWorktreeBranch(cwd, "vibe-wt/t2");
  expect(merged).toBe(false);
  // Tree is clean after the aborted merge (no half-merged state).
  const status = await run(cwd, ["status", "--porcelain"]);
  expect(status.stdout.trim()).toBe("");
});

test("gitAddWorktree excludes .vibe/ via .git/info/exclude (idempotently) so the worktree doesn't leak into git status", async () => {
  const cwd = await makeRepo();
  const wtPath = join(cwd, ".vibe", "worktrees", "e1");
  expect(await gitAddWorktree(cwd, { path: wtPath, branch: "vibe-wt/e1" })).toBe(wtPath);

  // The engine's runtime dir is excluded via the LOCAL exclude — not the tracked
  // .gitignore (which we never touch).
  const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
  expect(exclude).toMatch(/^\.vibe\/$/m);
  expect(existsSync(join(cwd, ".gitignore"))).toBe(false);

  // The nested worktree therefore does NOT surface in the user's status (no
  // `?? .vibe/` and no embedded-repo gitlink for a bare `git add -A`).
  const status = await run(cwd, ["status", "--porcelain"]);
  expect(status.stdout).not.toContain(".vibe");

  // Idempotent: a second worktree add doesn't append a duplicate `.vibe/` line.
  await gitAddWorktree(cwd, { path: join(cwd, ".vibe", "worktrees", "e2"), branch: "vibe-wt/e2" });
  const again = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
  expect((again.match(/^\.vibe\/$/gm) ?? []).length).toBe(1);
});

test("gitAddWorktree clears a stale leftover at the same path", async () => {
  const cwd = await makeRepo();
  const wtPath = join(cwd, ".vibe", "worktrees", "t3");
  expect(await gitAddWorktree(cwd, { path: wtPath, branch: "vibe-wt/t3a" })).toBe(wtPath);
  // Simulate a crashed run: the worktree dir + registration linger; re-add at the same path.
  expect(await gitAddWorktree(cwd, { path: wtPath, branch: "vibe-wt/t3b" })).toBe(wtPath);
});

test("codeCacheCleanCommand: JS caches only, never node_modules/dist; null for unknown", () => {
  const js = codeCacheCleanCommand({
    greenfield: false,
    primaryLanguage: "TypeScript",
    packageManager: "bun",
    framework: null,
    commands: {},
    monorepo: { tool: null, packages: [] },
    git: { isRepo: true, branch: "main", dirty: false },
    conventions: [],
    manifestFiles: ["package.json"],
  });
  expect(js).toContain(".next");
  expect(js).toContain("tsconfig.tsbuildinfo");
  expect(js).not.toContain(" dist");
  expect(js).not.toMatch(/rm[^;]*node_modules(?!\/\.(cache|vite))/);

  const none = codeCacheCleanCommand({
    greenfield: true,
    primaryLanguage: null,
    packageManager: null,
    framework: null,
    commands: {},
    monorepo: { tool: null, packages: [] },
    git: { isRepo: false, branch: null, dirty: false },
    conventions: [],
    manifestFiles: [],
  });
  expect(none).toBeNull();
});

test("gitStagedFiles + gitRestoreFiles: revert reverts new+modified merged paths, keeps sibling work", async () => {
  // A red post-merge gate must revert EXACTLY the merged paths — new files
  // removed, modified files restored to HEAD — while a sibling task's disjoint
  // changes survive. (A single `checkout HEAD -- <all>` aborts on a new path,
  // which is why gitRestoreFiles classifies added vs modified.)
  const cwd = await makeRepo();
  writeFileSync(join(cwd, "new.txt"), "winner-new\n");
  await run(cwd, ["add", "new.txt"]);
  writeFileSync(join(cwd, "a.txt"), "one\nwinner-mod\n"); // a.txt exists from makeRepo
  await run(cwd, ["add", "a.txt"]);
  writeFileSync(join(cwd, "sibling.txt"), "sibling\n"); // disjoint, untracked

  const merged = await gitStagedFiles(cwd);
  expect(merged.sort()).toEqual(["a.txt", "new.txt"]);
  await gitRestoreFiles(cwd, merged);

  expect(existsSync(join(cwd, "new.txt"))).toBe(false); // new file removed
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n"); // modified restored to HEAD
  expect(existsSync(join(cwd, "sibling.txt"))).toBe(true); // sibling untouched
  expect(await gitStagedFiles(cwd)).toEqual([]); // nothing left staged for the merged paths
});

test("revert scoped to the merge DELTA preserves a sibling's already-staged work (whole-index bug)", async () => {
  // Mirrors the orchestrator: sibling A already squash-merged (its file staged,
  // uncommitted) into the shared tree; task B merges then its gate goes red. The
  // revert must use B's DELTA (files newly staged by B's merge), NOT the whole
  // index — or A's completed green work is destroyed.
  const cwd = await makeRepo();
  writeFileSync(join(cwd, "siblingA.txt"), "A done\n"); // A's merged (staged) work
  await run(cwd, ["add", "siblingA.txt"]);
  const preStaged = new Set(await gitStagedFiles(cwd)); // captured BEFORE B's merge
  writeFileSync(join(cwd, "taskB.txt"), "B\n"); // B's merge stages its own file
  await run(cwd, ["add", "taskB.txt"]);
  const delta = (await gitStagedFiles(cwd)).filter((f) => !preStaged.has(f));
  expect(delta).toEqual(["taskB.txt"]); // only B's file, not A's
  await gitRestoreFiles(cwd, delta); // B's gate red → revert B's delta
  expect(existsSync(join(cwd, "siblingA.txt"))).toBe(true); // A's work survives
  expect(existsSync(join(cwd, "taskB.txt"))).toBe(false); // B's reverted
});

test("revert handles a staged RENAME (adversarial P3-1): old restored, new removed", async () => {
  // A squash-merge that renames a file stages it as a rename (`R100 old new`).
  // `--name-only` collapses that to the new path only, and the old classifier's
  // `\t`-split mis-parsed the `Rxxx\told\tnew` line — so a red gate left `old`
  // deleted and `new` as untracked cruft. gitStagedFiles now reports BOTH paths
  // (via `--name-status -z`) and gitRestoreFiles restores old + removes new.
  const cwd = await makeRepo(); // a.txt committed at HEAD
  await run(cwd, ["mv", "a.txt", "renamed.txt"]); // stage the rename
  const merged = await gitStagedFiles(cwd);
  expect(merged.sort()).toEqual(["a.txt", "renamed.txt"]); // both, not just the new path
  await gitRestoreFiles(cwd, merged);
  expect(existsSync(join(cwd, "renamed.txt"))).toBe(false); // new side removed
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n"); // old side restored to HEAD
  expect(await gitStagedFiles(cwd)).toEqual([]); // clean tree
});

test("revert handles a NON-ASCII path (adversarial P3-2): unicode new file removed", async () => {
  // Git C-quotes non-ASCII paths by default (`"caf\303\251.txt"`), so a
  // name-only capture fed that quoted literal back as a pathspec and the revert
  // no-op'd — the failing new file survived on main. `-z` emits raw paths.
  const cwd = await makeRepo();
  writeFileSync(join(cwd, "café.txt"), "y\n"); // non-ASCII new file from a merge
  await run(cwd, ["add", "-A"]);
  const merged = await gitStagedFiles(cwd);
  expect(merged).toEqual(["café.txt"]); // raw, not `"caf\303\251.txt"`
  await gitRestoreFiles(cwd, merged);
  expect(existsSync(join(cwd, "café.txt"))).toBe(false); // removed despite the accent
  expect(await gitStagedFiles(cwd)).toEqual([]);
});

test("revert handles a space-in-path delta: sibling preserved, our merge reverted", async () => {
  // Path-with-space is the other C-quoting trigger; verify the preStaged delta
  // capture + revert still scopes correctly when paths contain spaces.
  const cwd = await makeRepo();
  writeFileSync(join(cwd, "sib.txt"), "sibling staged\n");
  await run(cwd, ["add", "sib.txt"]); // sibling's prior green work, staged
  const preStaged = new Set(await gitStagedFiles(cwd));
  writeFileSync(join(cwd, "a.txt"), "one\nBAD\n"); // our merge modifies a tracked file…
  writeFileSync(join(cwd, "new one.txt"), "n\n"); // …and adds one with a space
  await run(cwd, ["add", "-A"]);
  const delta = (await gitStagedFiles(cwd)).filter((f) => !preStaged.has(f));
  expect(delta.sort()).toEqual(["a.txt", "new one.txt"]);
  await gitRestoreFiles(cwd, delta);
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n"); // reverted
  expect(existsSync(join(cwd, "new one.txt"))).toBe(false); // removed
  expect(await gitStagedFiles(cwd)).toEqual(["sib.txt"]); // sibling survives, still staged
});
