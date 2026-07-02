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
  gitDiffSince,
  codeCacheCleanCommand,
} from "./gitops.ts";
import { spawnGit } from "../git-info.ts";

const run = (cwd: string, args: string[]) => spawnGit(cwd, args);

async function makeRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-gitops-"));
  await run(cwd, ["init", "-q", "-b", "main"]);
  await run(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "root"]);
  writeFileSync(join(cwd, "a.txt"), "one\n");
  await run(cwd, ["add", "-A"]);
  await run(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "a"]);
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
  await run(wtPath, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "wt edit"]);

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
  await run(wtPath, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "wt"]);
  writeFileSync(join(cwd, "a.txt"), "main-version\n");
  await run(cwd, ["add", "-A"]);
  await run(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "main"]);

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
    greenfield: false, primaryLanguage: "TypeScript", packageManager: "bun", framework: null,
    commands: {}, monorepo: { tool: null, packages: [] }, git: { isRepo: true, branch: "main", dirty: false },
    conventions: [], manifestFiles: ["package.json"],
  });
  expect(js).toContain(".next");
  expect(js).toContain("tsconfig.tsbuildinfo");
  expect(js).not.toContain(" dist");
  expect(js).not.toMatch(/rm[^;]*node_modules(?!\/\.(cache|vite))/);

  const none = codeCacheCleanCommand({
    greenfield: true, primaryLanguage: null, packageManager: null, framework: null,
    commands: {}, monorepo: { tool: null, packages: [] }, git: { isRepo: false, branch: null, dirty: false },
    conventions: [], manifestFiles: [],
  });
  expect(none).toBeNull();
});
