import { test, expect } from "bun:test";
import { readGitInfo, type GitRunner, type GitRunResult } from "./git-info.ts";

/** A runner that answers each git subcommand from a fixed table (by first arg). */
function fakeGit(table: Record<string, GitRunResult>): GitRunner {
  return async (_cwd, args) => {
    // Key on the git subcommand (rev-parse/status/rev-list), refined by 2nd arg.
    const key = args.join(" ");
    for (const [prefix, res] of Object.entries(table)) {
      if (key.startsWith(prefix)) return res;
    }
    return { ok: false, stdout: "", stderr: "no fixture" };
  };
}

const ok = (stdout: string): GitRunResult => ({ ok: true, stdout, stderr: "" });
const fail: GitRunResult = { ok: false, stdout: "", stderr: "" };

test("returns undefined outside a git repo", async () => {
  const run = fakeGit({ "rev-parse --abbrev-ref": fail });
  expect(await readGitInfo("/x", run)).toBeUndefined();
});

test("parses branch, dirty count, ahead/behind, and worktree state", async () => {
  const run = fakeGit({
    "rev-parse --abbrev-ref": ok("feature/x\n"),
    "status --porcelain": ok(" M a.ts\n?? b.ts\n M c.ts\n"),
    "rev-list --left-right": ok("2\t5\n"), // behind=2, ahead=5
    "rev-parse --git-dir": ok("/repo/.git/worktrees/wt\n"),
    "rev-parse --git-common-dir": ok("/repo/.git\n"),
  });
  expect(await readGitInfo("/repo", run)).toEqual({
    branch: "feature/x",
    dirty: 3,
    ahead: 5,
    behind: 2,
    worktree: true,
  });
});

test("treats a missing upstream as 0 ahead / 0 behind", async () => {
  const run = fakeGit({
    "rev-parse --abbrev-ref": ok("main\n"),
    "status --porcelain": ok(""),
    "rev-list --left-right": fail, // no upstream
    "rev-parse --git-dir": ok(".git\n"),
    "rev-parse --git-common-dir": ok(".git\n"),
  });
  expect(await readGitInfo("/repo", run)).toMatchObject({
    branch: "main",
    dirty: 0,
    ahead: 0,
    behind: 0,
    worktree: false, // git-dir === common-dir → not a linked worktree
  });
});
