/**
 * Git operations for the Electron shell.
 *
 * Spawns `git` directly (same pattern as `vibe-codr/packages/core/src/git-info.ts`)
 * to read working-tree state and perform branch/commit/merge/push/pull actions.
 * These are shell-level operations — the agent loop is never involved.
 */

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Readable } from "node:stream";
import { assertGitRef, assertGitRemote } from "./git-ref";
import type {
  GitBranch,
  GitCommitInfo,
  GitFullStatus,
  GitFileDiffResult,
  GitRemote,
  GitResult,
  GitStatusEntry,
} from "./git-types";
import {
  appendCapture,
  captureOverflowError,
  createCaptureBuffers,
  DEFAULT_CAPTURE_MAX_BYTES,
} from "./stream-cap";

const GIT_TIMEOUT_MS = 30_000;

/** Cap captured stdout/stderr so a huge porcelain dump cannot pin the main process. */
const GIT_MAX_CAPTURE_BYTES = DEFAULT_CAPTURE_MAX_BYTES;

interface SpawnedChild {
  stdout: Readable;
  stderr: Readable;
  kill(signal?: string): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close", cb: (code: number | null) => void): void;
}

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
}

/** Spawn a git command in `cwd` and return trimmed streams + success. */
/** PATH enrichment so GUI-launched spawns find Homebrew git (Dock/Finder PATH is thin). */
function gitEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? "";
  const extras = [
    home ? `${home}/.bun/bin` : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter(Boolean).join(":");
  const path = process.env.PATH ? `${extras}:${process.env.PATH}` : extras;
  return { ...process.env, PATH: path };
}

export async function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as SpawnedChild;
    const capture = createCaptureBuffers(GIT_MAX_CAPTURE_BYTES);
    let forceTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;
    let timedOut = false;
    let settled = false;
    const finish = (result: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        hardTimer = setTimeout(() => {
          finish({
            ok: false,
            stdout: capture.stdout,
            stderr: capture.stderr || "git command timed out",
            exitCode: null,
            truncated: capture.truncated,
          });
        }, 2_000);
      }, 2_000);
    }, GIT_TIMEOUT_MS);
    const clearTimers = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };

    child.stdout.on("data", (chunk: Buffer) => appendCapture(capture, "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => appendCapture(capture, "stderr", chunk));
    child.on("error", (err: Error) => {
      finish({
        ok: false,
        stdout: capture.stdout,
        stderr: err.message,
        exitCode: null,
        truncated: capture.truncated,
      });
    });
    child.on("close", (code: number | null) => {
      if (capture.truncated) {
        finish({
          ok: false,
          stdout: capture.stdout,
          stderr: captureOverflowError(capture, "git output"),
          exitCode: code,
          truncated: true,
        });
        return;
      }
      finish({
        ok: !timedOut && code === 0,
        stdout: capture.stdout,
        stderr: timedOut
          ? capture.stderr || "git command timed out"
          : capture.stderr,
        exitCode: code,
        truncated: false,
      });
    });
  });
}

/** Check if `cwd` is inside a git repository. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return res.ok && res.stdout.trim() === "true";
}

function diffLineCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/** Current HEAD-to-working-tree diff for one project-contained file. Finds a
 * nested repository (common when an agent scaffolds inside the opened folder)
 * and synthesizes a normal unified diff for untracked files. */
export async function getWorkingTreeFileDiff(
  target: string,
): Promise<GitFileDiffResult> {
  let existingAncestor = dirname(target);
  let canonicalAncestor: string | null = null;
  while (canonicalAncestor === null) {
    canonicalAncestor = await realpath(existingAncestor).catch(() => null);
    if (canonicalAncestor !== null) break;
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) return { ok: true, available: false };
    existingAncestor = parent;
  }
  const location = canonicalAncestor;
  const canonicalTarget = join(location, relative(existingAncestor, target));
  const rootResult = await runGit(location, ["rev-parse", "--show-toplevel"]);
  if (!rootResult.ok) return { ok: true, available: false };
  const repoRoot = rootResult.stdout.trim();
  const repoPath = relative(repoRoot, canonicalTarget);
  if (!repoRoot || !repoPath || repoPath === ".." || repoPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    return { ok: false, error: "Changed file is outside its Git repository" };
  }

  const [tracked, head] = await Promise.all([
    runGit(repoRoot, ["ls-files", "--error-unmatch", "--", repoPath]),
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]),
  ]);
  const diff = tracked.ok && head.ok
    ? await runGit(repoRoot, ["diff", "--no-ext-diff", "--no-color", "HEAD", "--", repoPath])
    : await runGit(repoRoot, [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--no-index",
        "--",
        process.platform === "win32" ? "NUL" : "/dev/null",
        canonicalTarget,
      ]);

  // `git diff --no-index` returns 1 when differences are present.
  if (!diff.ok && (diff.exitCode !== 1 || diff.truncated)) {
    return { ok: false, error: diff.stderr || "Could not read file diff" };
  }
  const counts = diffLineCounts(diff.stdout);
  return { ok: true, available: true, diff: diff.stdout, ...counts };
}

function parseRemoteUrl(url: string): { host?: string; owner?: string; repo?: string } {
  // SSH: git@github.com:owner/repo.git
  const ssh = url.match(/^[\w-]+@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) {
    return { host: ssh[1], owner: ssh[2], repo: ssh[3] };
  }
  // HTTPS: https://github.com/owner/repo.git
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return { host: u.host, owner: parts[0], repo: parts[1] };
    }
  } catch {
    /* not a URL */
  }
  return {};
}

const SENSITIVE_REMOTE_QUERY_KEY = /(?:token|key|auth|password|passwd|secret|signature|credential)/i;

/**
 * Remote URLs are presentation metadata only; git mutations address the remote
 * by name. Strip embedded URL credentials and redact secret-like query values
 * before the object crosses into the renderer or lands in a screenshot/log.
 * SCP-style SSH URLs contain a public username, not a credential, and are kept.
 */
export function redactRemoteUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase() === "sig" || SENSITIVE_REMOTE_QUERY_KEY.test(key)) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

export async function listRemotes(cwd: string): Promise<GitRemote[]> {
  const res = await runGit(cwd, ["remote", "-v"]);
  if (!res.ok) return [];
  const seen = new Set<string>();
  const remotes: GitRemote[] = [];
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)/);
    if (!m) continue;
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const rawUrl = m[2]!;
    const parsed = parseRemoteUrl(rawUrl);
    remotes.push({ name, url: redactRemoteUrl(rawUrl), ...parsed });
  }
  return remotes;
}

export async function listBranches(cwd: string): Promise<GitBranch[]> {
  const [local, remote] = await Promise.all([
    runGit(cwd, [
      "for-each-ref",
      "--format=%(HEAD)%00%(refname:short)%00%(upstream:short)%00%(committerdate:unix)%00%(subject)",
      "refs/heads/",
    ]),
    runGit(cwd, [
      "for-each-ref",
      "--format=%(refname:short)%00%(committerdate:unix)%00%(subject)",
      "refs/remotes/",
    ]),
  ]);

  const branches: GitBranch[] = [];

  if (local.ok) {
    for (const line of local.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [head, name, upstream, dateStr, ...subjectParts] = line.split("\0");
      const subject = subjectParts.join("\0");
      branches.push({
        name: name ?? "",
        current: head === "*",
        remote: false,
        upstream: upstream || undefined,
        lastSubject: subject || undefined,
        lastDate: dateStr ? Number(dateStr) * 1000 : undefined,
      });
    }
  }

  if (remote.ok) {
    for (const line of remote.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, dateStr, ...subjectParts] = line.split("\0");
      const subject = subjectParts.join("\0");
      branches.push({
        name: name ?? "",
        current: false,
        remote: true,
        lastSubject: subject || undefined,
        lastDate: dateStr ? Number(dateStr) * 1000 : undefined,
      });
    }
  }

  // Enrich only the *current* local branch with ahead/behind — O(branches)
  // rev-list fan-out made status open lag on large repos.
  const current = branches.find((b) => b.current && !b.remote && b.upstream);
  if (current?.upstream) {
    const counts = await runGit(cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `${current.upstream}...${current.name}`,
    ]);
    if (counts.ok) {
      const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
      current.behind = behind || 0;
      current.ahead = ahead || 0;
    }
  }

  return branches;
}

export async function recentCommits(cwd: string, count = 20): Promise<GitCommitInfo[]> {
  const res = await runGit(cwd, [
    "log", `-${count}`, "--format=%H%x00%h%x00%an%x00%at%x00%s",
  ]);
  if (!res.ok) return [];
  const commits: GitCommitInfo[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [hash, shortHash, author, dateStr, ...subjectParts] = line.split("\0");
    const subject = subjectParts.join("\0");
    commits.push({
      hash: hash ?? "",
      shortHash: shortHash ?? "",
      author: author ?? "",
      date: dateStr ? Number(dateStr) * 1000 : 0,
      subject: subject ?? "",
    });
  }
  return commits;
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 * Entries are NUL-separated; renames/copies emit two path fields.
 * Exported for pure unit tests.
 */
export function parsePorcelainZ(stdout: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  // Split on NUL but keep empty trailing segments out
  const parts = stdout.split("\0");
  let i = 0;
  while (i < parts.length) {
    const record = parts[i] ?? "";
    if (!record) {
      i += 1;
      continue;
    }
    // XY<path> — first two chars are status, then space, then path
    if (record.length < 3) {
      i += 1;
      continue;
    }
    const index = record[0] ?? " ";
    const working = record[1] ?? " ";
    // Format is "XY PATH" (space at index 2)
    const path = record[2] === " " ? record.slice(3) : record.slice(2);
    const isRenameOrCopy = index === "R" || index === "C" || working === "R" || working === "C";
    if (isRenameOrCopy) {
      // Next field is the other path (source for rename)
      const other = parts[i + 1] ?? "";
      i += 2;
      entries.push({
        index,
        working,
        path: path || other,
        oldPath: other || undefined,
      });
    } else {
      i += 1;
      entries.push({ index, working, path });
    }
  }
  return entries;
}

/** @deprecated Use parsePorcelainZ with -z status. Kept for tests of line-oriented input. */
export function parsePorcelain(stdout: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const index = line[0] ?? " ";
    const working = line[1] ?? " ";
    const rest = line.slice(3);
    if (rest.includes(" -> ")) {
      const [oldPath, newPath] = rest.split(" -> ");
      entries.push({ index, working, path: newPath ?? rest, oldPath: oldPath });
    } else {
      entries.push({ index, working, path: rest });
    }
  }
  return entries;
}

export async function getFullStatus(cwd: string): Promise<GitFullStatus | null> {
  const [branchRes, statusRes, countsRes, remotes, branches, commits] = await Promise.all([
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(cwd, ["status", "--porcelain=v1", "-z"]),
    runGit(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    listRemotes(cwd),
    listBranches(cwd),
    recentCommits(cwd),
  ]);

  if (!branchRes.ok) return null;

  const branch = branchRes.stdout.trim() || "HEAD";
  const entries = parsePorcelainZ(statusRes.stdout);
  const [behind, ahead] = countsRes.ok
    ? countsRes.stdout.trim().split(/\s+/).map(Number)
    : [0, 0];

  // Find upstream name for the current branch
  const currentBranch = branches.find((b) => b.current);
  const upstream = currentBranch?.upstream;

  const stagedCount = entries.filter((e) => e.index !== " " && e.index !== "?").length;
  const unstagedCount = entries.filter((e) => e.working !== " " && e.working !== "?").length;
  const untrackedCount = entries.filter((e) => e.index === "?").length;

  return {
    branch,
    upstream,
    ahead: ahead || 0,
    behind: behind || 0,
    clean: entries.length === 0,
    entries,
    stagedCount,
    unstagedCount,
    untrackedCount,
    remotes,
    branches,
    recentCommits: commits,
  };
}

// ── Mutating operations ──────────────────────────────────────────────────

function refError(err: unknown): GitResult {
  return {
    ok: false,
    stdout: "",
    stderr: err instanceof Error ? err.message : String(err),
  };
}

export async function createBranch(
  cwd: string,
  name: string,
  from?: string,
  checkout?: boolean,
): Promise<GitResult> {
  let safeName: string;
  let base: string;
  try {
    safeName = assertGitRef(name, "branch");
    base = from ? assertGitRef(from, "base") : "HEAD";
  } catch (err) {
    return refError(err);
  }
  // After assertGitRef (no leading `-`), pass the branch as a normal ref arg.
  // Do NOT put `--` between `-b` and the name — git would treat `--` as the branch.
  if (checkout) {
    const res = await runGit(cwd, ["checkout", "-b", safeName, base]);
    return {
      ok: res.ok,
      stdout: res.stdout,
      stderr: res.stderr,
      message: res.ok ? `Created and switched to ${safeName}` : undefined,
    };
  }
  const res = await runGit(cwd, ["branch", safeName, base]);
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    message: res.ok ? `Created branch ${safeName}` : undefined,
  };
}

export async function checkoutBranch(
  cwd: string,
  name: string,
  track?: boolean,
): Promise<GitResult> {
  let safeName: string;
  try {
    safeName = assertGitRef(name, "branch");
  } catch (err) {
    return refError(err);
  }
  // Branch is a ref, not a pathspec — never place it after bare `--`.
  const args = track ? ["checkout", "-t", safeName] : ["checkout", safeName];
  const res = await runGit(cwd, args);
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    message: res.ok ? `Switched to ${safeName}` : undefined,
  };
}

export async function deleteBranch(
  cwd: string,
  name: string,
  force?: boolean,
): Promise<GitResult> {
  let safeName: string;
  try {
    safeName = assertGitRef(name, "branch");
  } catch (err) {
    return refError(err);
  }
  // `-d`/`-D` already consume the next arg as the branch name; `--` is optional.
  const args = ["branch", force ? "-D" : "-d", safeName];
  const res = await runGit(cwd, args);
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    message: res.ok ? `Deleted branch ${safeName}` : undefined,
  };
}

export async function stageFiles(cwd: string, paths: string[]): Promise<GitResult> {
  // Empty paths must NOT unstage the index — that is unstageAll / unstageFiles([]).
  if (paths.length === 0) {
    return {
      ok: false,
      stdout: "",
      stderr: "No paths to stage",
      message: undefined,
    };
  }
  const res = await runGit(cwd, ["add", "--", ...paths]);
  return { ok: res.ok, stdout: res.stdout, stderr: res.stderr, message: res.ok ? `Staged ${paths.length} file(s)` : undefined };
}

/** Unstage specific paths (`git restore --staged -- …`). */
export async function unstageFiles(cwd: string, paths: string[]): Promise<GitResult> {
  if (paths.length === 0) {
    return unstageAll(cwd);
  }
  // Prefer restore --staged (Git 2.23+); fall back to reset HEAD for older git.
  const restore = await runGit(cwd, ["restore", "--staged", "--", ...paths]);
  if (restore.ok) {
    return {
      ok: true,
      stdout: restore.stdout,
      stderr: restore.stderr,
      message: `Unstaged ${paths.length} file(s)`,
    };
  }
  const res = await runGit(cwd, ["reset", "HEAD", "--", ...paths]);
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr || restore.stderr,
    message: res.ok ? `Unstaged ${paths.length} file(s)` : undefined,
  };
}

/** Unstage everything in the index (`git reset --mixed HEAD`). */
export async function unstageAll(cwd: string): Promise<GitResult> {
  const res = await runGit(cwd, ["reset", "--mixed", "HEAD"]);
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    message: res.ok ? "Unstaged all" : undefined,
  };
}

export async function stageAll(cwd: string, includeUntracked: boolean): Promise<GitResult> {
  const res = await runGit(cwd, ["add", includeUntracked ? "-A" : "-u"]);
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    message: res.ok ? "Staged all changes" : undefined,
  };
}

export async function commit(
  cwd: string,
  message: string,
  opts: { stageAll?: boolean; stageAllIncludingUntracked?: boolean; amend?: boolean },
): Promise<GitResult> {
  if (opts.stageAll || opts.stageAllIncludingUntracked) {
    const stage = await stageAll(cwd, opts.stageAllIncludingUntracked ?? false);
    if (!stage.ok) return stage;
  }
  const args = ["commit"];
  if (opts.amend) {
    args.push("--amend");
    // When a new message is given, replace the old one; otherwise keep it.
    if (message.trim()) args.push("-m", message);
    else args.push("--no-edit");
  } else {
    if (!message.trim()) {
      return { ok: false, stdout: "", stderr: "Commit message is required" };
    }
    args.push("-m", message);
  }
  const res = await runGit(cwd, args);
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    message: res.ok ? (opts.amend ? "Amended commit" : "Committed") : undefined,
  };
}

export async function mergeBranch(
  cwd: string,
  branch: string,
  noFastForward?: boolean,
): Promise<GitResult> {
  let safeBranch: string;
  try {
    safeBranch = assertGitRef(branch, "branch");
  } catch (err) {
    return refError(err);
  }
  // Validated ref as the merge tip — not a pathspec after bare `--`.
  const args = noFastForward
    ? ["merge", "--no-ff", safeBranch]
    : ["merge", safeBranch];
  const res = await runGit(cwd, args);
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    message: res.ok ? `Merged ${safeBranch}` : undefined,
  };
}

/**
 * Build `git push` argv (pure). Exported so tests assert force-with-lease
 * without a network remote — bare `--force` must not appear for `force: true`.
 */
export function buildPushArgs(opts: {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
  /** Prefer --force-with-lease (default when force). Set forceUnsafe for true --force. */
  force?: boolean;
  forceUnsafe?: boolean;
}): string[] {
  const remote = assertGitRemote(opts.remote ?? "origin");
  const branch = opts.branch ? assertGitRef(opts.branch, "branch") : undefined;
  const args = ["push"];
  if (opts.setUpstream) args.push("-u");
  if (opts.force || opts.forceUnsafe) {
    // Industry default: force-with-lease. True --force only when forceUnsafe.
    args.push(opts.forceUnsafe ? "--force" : "--force-with-lease");
  }
  args.push(remote);
  if (branch) args.push(branch);
  return args;
}

export async function pushBranch(
  cwd: string,
  opts: {
    remote?: string;
    branch?: string;
    setUpstream?: boolean;
    force?: boolean;
    forceUnsafe?: boolean;
  },
): Promise<GitResult> {
  let args: string[];
  try {
    args = buildPushArgs(opts);
  } catch (err) {
    return refError(err);
  }
  const res = await runGit(cwd, args);
  const remote = opts.remote ?? "origin";
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    message: res.ok ? `Pushed to ${remote}` : undefined,
  };
}

export async function pullBranch(
  cwd: string,
  opts: { remote?: string; branch?: string },
): Promise<GitResult> {
  const args = ["pull"];
  try {
    if (opts.remote) args.push(assertGitRemote(opts.remote));
    if (opts.branch) args.push(assertGitRef(opts.branch, "branch"));
  } catch (err) {
    return refError(err);
  }
  const res = await runGit(cwd, args);
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    message: res.ok ? "Pulled latest" : undefined,
  };
}

export async function fetchRemotes(cwd: string, remote?: string): Promise<GitResult> {
  const args = ["fetch", "--prune"];
  if (remote) {
    try {
      args.push(assertGitRemote(remote));
    } catch (err) {
      return refError(err);
    }
  }
  const res = await runGit(cwd, args);
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    message: res.ok ? "Fetched latest" : undefined,
  };
}
