import type { GitInfo } from "@vibe/shared";
import { killTree } from "@vibe/tools";

/** Wall-clock bound on a git spawn (gitPrepare/gitCommitGreen run inside the
 * gate's finally; a wedged git would freeze the queue). On timeout killTree
 * closes the pipes so the readers finish and the !ok path degrades. Generous —
 * large repos are legitimately slow. */
const GIT_TIMEOUT_MS = 120_000;

/**
 * Working-tree git introspection for the header (branch, dirty count, ahead/behind,
 * worktree). Lifted out of engine.ts so the porcelain parsing is unit-tested
 * against fixed command output rather than only exercised through a live repo.
 * The command runner is injectable (defaults to spawning real `git`).
 */

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs a git subcommand in `cwd` and returns its trimmed streams + success. */
export type GitRunner = (cwd: string, args: string[]) => Promise<GitRunResult>;

/** Default runner: spawn real `git` (stdin ignored so it can never block on a prompt). */
export const spawnGit: GitRunner = async (cwd, args) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => {
    killTree(proc.pid);
  }, GIT_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Best-effort git state for the header. Returns undefined outside a repo (so the
 * header simply omits git context). Never throws for the caller's convenience.
 */
export async function readGitInfo(
  cwd: string,
  run: GitRunner = spawnGit,
): Promise<GitInfo | undefined> {
  const branchRes = await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branchRes.ok) return undefined; // not a repo
  const branch = branchRes.stdout.trim() || "HEAD";
  const [status, counts, gitDir, commonDir] = await Promise.all([
    run(cwd, ["status", "--porcelain"]),
    run(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    run(cwd, ["rev-parse", "--git-dir"]),
    run(cwd, ["rev-parse", "--git-common-dir"]),
  ]);
  const dirty = status.ok ? status.stdout.split("\n").filter((l) => l.trim().length > 0).length : 0;
  // `@{upstream}` fails with no upstream — treat as 0/0.
  const [behind, ahead] = counts.ok
    ? counts.stdout
        .trim()
        .split(/\s+/)
        .map((n) => Number(n) || 0)
    : [0, 0];
  // Inside a linked worktree the per-worktree git-dir differs from the common dir.
  const worktree = gitDir.ok && commonDir.ok && gitDir.stdout.trim() !== commonDir.stdout.trim();
  return { branch, dirty, ahead: ahead ?? 0, behind: behind ?? 0, worktree };
}
