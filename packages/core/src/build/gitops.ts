import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { RepoProfile } from "@vibe/shared";
import { type GitRunner, spawnGit } from "../git-info.ts";
import { looksGreenfield } from "./codeintel.ts";

/**
 * Engine-owned git primitives for the build flow (ported from agentswarm
 * codeintel, rebuilt on argv arrays — no shell interpolation). Fixed engine
 * identity (never the user's git config), never pushes, never force-pushes;
 * the only reset lives behind an explicit owned-tree contract. All best-effort:
 * a git failure degrades to "feature unavailable", never throws.
 */

/** Fixed engine identity + no signing, as argv config flags. */
export const GIT_IDENTITY: string[] = [
  "-c",
  "user.name=vibecodr",
  "-c",
  "user.email=agent@vibecodr.local",
  "-c",
  "commit.gpgsign=false",
];

const id = (args: string[]): string[] => [...GIT_IDENTITY, ...args];

function firstLine(s: string): string {
  return (s ?? "").split("\n")[0]?.trim() ?? "";
}

/**
 * Decide whether (and on which branch) the engine may commit in BRANCH mode
 * (`build.commit.mode: "branch"` — opt-in; the default checkpoint mode never
 * needs this). Three-tier safety:
 *   owned tree (managed/greenfield) → git init if needed; commit freely.
 *   real repo                       → checkout a work branch; REFUSE if dirty.
 * Never pushes or resets.
 */
export async function gitPrepare(
  cwd: string,
  opts: { branch: string; ownTree?: boolean; run?: GitRunner },
): Promise<{ ok: boolean; branch: string | null; reason?: string }> {
  const run = opts.run ?? spawnGit;
  const owns = opts.ownTree === true;
  const repo = await run(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!repo.ok || !/true/.test(repo.stdout)) {
    // Never silently turn the user's non-git directory into a repo and commit
    // their whole tree. Auto-init only an owned workspace or a genuinely empty
    // host directory; otherwise refuse (the session proceeds without commits).
    if (!owns) {
      const ls = Bun.spawnSync(["ls", "-A"], { cwd });
      const entries = ls.success
        ? new TextDecoder().decode(ls.stdout).split("\n").map((l) => l.trim()).filter(Boolean)
        : ["unknown"];
      if (!looksGreenfield(entries)) {
        return {
          ok: false,
          branch: null,
          reason: "non-empty non-git directory — run `git init` first to enable branch commits",
        };
      }
    }
    const init = await run(cwd, id(["init", "-q"]));
    if (!init.ok) return { ok: false, branch: null, reason: `git init failed: ${firstLine(init.stderr)}` };
    await run(cwd, id(["add", "-A"]));
    await run(cwd, id(["commit", "-q", "-m", "vibecodr: baseline", "--allow-empty"]));
    const co = await run(cwd, id(["checkout", "-B", opts.branch]));
    return co.ok
      ? { ok: true, branch: opts.branch }
      : { ok: false, branch: null, reason: `could not create work branch: ${firstLine(co.stderr)}` };
  }
  // Existing repo. On the user's real directory, never touch a dirty tree.
  if (!owns) {
    const dirty = await run(cwd, ["status", "--porcelain"]);
    if (dirty.ok && dirty.stdout.trim()) {
      return {
        ok: false,
        branch: null,
        reason: "working tree has uncommitted changes — branch commits disabled (commit or stash to enable)",
      };
    }
  }
  const co = await run(cwd, id(["checkout", "-B", opts.branch]));
  if (!co.ok) return { ok: false, branch: null, reason: `could not create work branch: ${firstLine(co.stderr)}` };
  return { ok: true, branch: opts.branch };
}

/**
 * Commit the current tree (branch-mode commit-on-green). Returns the new short
 * SHA, or null when there was nothing to commit or git failed. `--no-verify`:
 * the green gate already ran the repo's real checks — a user commit hook
 * re-running them (or failing on the engine identity) must not block.
 */
export async function gitCommitGreen(
  cwd: string,
  message: string,
  run: GitRunner = spawnGit,
): Promise<string | null> {
  const add = await run(cwd, id(["add", "-A"]));
  if (!add.ok) return null;
  const status = await run(cwd, ["status", "--porcelain"]);
  if (!status.ok || !status.stdout.trim()) return null; // nothing staged → no empty commit
  const commit = await run(cwd, id(["commit", "-q", "--no-verify", "-m", message.slice(0, 200)]));
  if (!commit.ok) return null;
  const sha = await run(cwd, ["rev-parse", "--short", "HEAD"]);
  return sha.ok ? firstLine(sha.stdout) || null : null;
}

/**
 * Create an isolated git worktree off HEAD so parallel writer tasks can edit
 * the same files without colliding. Returns the worktree path, or null when
 * worktrees aren't usable. Clears any stale leftover at the deterministic path
 * first (a SIGKILLed prior run leaves a registered worktree that would make
 * `add` fail forever). The branch name must be fresh per call.
 */
export async function gitAddWorktree(
  cwd: string,
  opts: { path: string; branch: string; run?: GitRunner },
): Promise<string | null> {
  const run = opts.run ?? spawnGit;
  const repo = await run(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!repo.ok || !/true/.test(repo.stdout)) return null;
  // Keep the engine's runtime state (`.vibe/` — worktrees, journals, reports,
  // checkpoints) out of the user's git view via the repo's LOCAL exclude, so a
  // nested worktree can't leak into `git status`, the green-gate diff reviewer,
  // checkpoint snapshots, or a branch-mode `git add -A`. We never touch the
  // user's tracked `.gitignore`; this is idempotent and best-effort.
  await excludeVibeRuntime(cwd, run);
  await run(cwd, id(["worktree", "remove", "--force", opts.path]));
  Bun.spawnSync(["rm", "-rf", opts.path]);
  await run(cwd, id(["worktree", "prune"]));
  // Delete a STALE leftover branch at the deterministic name too: a SIGKILL after
  // this created the branch but before teardown leaves it behind, and since the
  // branch name is deterministic per task, a `--resume` re-run's `add -b` would
  // fail ("branch already exists") → the task silently degrades to the shared tree,
  // losing its isolation. The branch is a `vibe-wt/…` name we own (never the user's
  // or a checked-out one, since we just pruned the worktree), so -D is safe.
  await run(cwd, id(["branch", "-D", opts.branch]));
  const r = await run(cwd, id(["worktree", "add", "-b", opts.branch, opts.path, "HEAD"]));
  return r.ok ? opts.path : null;
}

/**
 * Idempotently exclude the engine's `.vibe/` runtime directory via the repo's
 * LOCAL exclude file (`$GIT_COMMON_DIR/info/exclude`) — never the user's tracked
 * `.gitignore`. Written once per worktree creation so the engine's own state
 * (nested worktrees especially, which `git add -A` would otherwise stage as an
 * embedded-repo gitlink) never surfaces in the user's status/diffs/commits.
 * Best-effort: a failure to read/write the exclude file must never fail worktree
 * creation.
 */
async function excludeVibeRuntime(cwd: string, run: GitRunner): Promise<void> {
  try {
    // The exclude lives in the COMMON git dir (shared across linked worktrees),
    // not a per-worktree `.git` file, so resolve `--git-common-dir`.
    const r = await run(cwd, ["rev-parse", "--git-common-dir"]);
    const gitDir = firstLine(r.stdout);
    if (!r.ok || !gitDir) return;
    const excludePath = join(isAbsolute(gitDir) ? gitDir : join(cwd, gitDir), "info", "exclude");
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (/^\s*\.vibe\/?\s*$/m.test(existing)) return; // already excluded → no-op
    mkdirSync(dirname(excludePath), { recursive: true });
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(excludePath, `${sep}.vibe/\n`);
  } catch {
    /* best-effort: never fail a worktree over a local-exclude write */
  }
}

/**
 * Commit everything in a worktree under the fixed engine identity. Agents don't
 * commit their own work, but `gitMergeWorktreeBranch` squash-merges the BRANCH —
 * which only sees COMMITTED history — so a worktree task's edits must be committed
 * before its branch can be merged back. Returns false when there was nothing to
 * commit (the task changed nothing) or git failed. `--no-verify`: this is an
 * internal, about-to-be-squashed commit, so a user commit hook must not block it.
 */
export async function commitWorktree(
  wtPath: string,
  message: string,
  run: GitRunner = spawnGit,
): Promise<boolean> {
  const add = await run(wtPath, id(["add", "-A"]));
  if (!add.ok) return false;
  const status = await run(wtPath, ["status", "--porcelain"]);
  if (!status.ok || !status.stdout.trim()) return false; // nothing changed → no commit
  const commit = await run(wtPath, id(["commit", "-q", "--no-verify", "-m", message.slice(0, 200)]));
  return commit.ok;
}

/** Remove a worktree (and its branch) created by gitAddWorktree. Best-effort. */
export async function gitRemoveWorktree(
  cwd: string,
  wtPath: string,
  branch: string,
  run: GitRunner = spawnGit,
): Promise<void> {
  await run(cwd, id(["worktree", "remove", "--force", wtPath]));
  await run(cwd, id(["branch", "-D", branch]));
}

/**
 * Squash-merge a worktree's branch into the current branch (its changes land
 * as working-tree changes, uncommitted). Returns true on a clean merge; a
 * conflicting merge is aborted and returns false — the task fails with the
 * conflict as feedback rather than leaving a half-merged tree.
 */
export async function gitMergeWorktreeBranch(
  cwd: string,
  branch: string,
  run: GitRunner = spawnGit,
): Promise<boolean> {
  const r = await run(cwd, id(["merge", "--squash", branch]));
  if (r.ok) return true;
  // A squash-merge fails in one of two shapes, and the cleanup must NOT be a
  // blanket `git reset` — when several worktree tasks squash-merge into ONE
  // uncommitted tree, an earlier task's changes are already STAGED here, and a
  // blanket reset silently reverts them (verified). Instead:
  //   (a) refused to start (its target files have local changes a prior merge
  //       staged) → git touched nothing, so leave the tree exactly as-is; OR
  //   (b) started and hit content conflicts → discard just the conflicted paths
  //       back to HEAD (note `merge --squash` leaves no MERGE_HEAD, so detect the
  //       half-merge via unmerged index entries, not a merge-in-progress state).
  // `-z` (NUL-delimited, raw paths) so a conflicted path with spaces or non-ASCII
  // characters isn't C-quoted into a bogus pathspec that `checkout` then no-ops on.
  const unmerged = await run(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  const conflicted = unmerged.ok ? unmerged.stdout.split("\0").filter(Boolean) : [];
  if (conflicted.length) await run(cwd, id(["checkout", "HEAD", "--", ...conflicted]));
  return false;
}

/** Parse `git ... --name-status -z` output into (status, paths) records. The
 * `-z` stream is `status\0path\0…` with rename/copy (R/C) records carrying TWO
 * paths (`R100\0old\0new`); every other status carries one. Raw paths — `-z`
 * disables git's C-quoting, so non-ASCII/space paths survive intact. */
function parseNameStatusZ(out: string): { status: string; paths: string[] }[] {
  const toks = out.split("\0").filter((t) => t.length > 0);
  const recs: { status: string; paths: string[] }[] = [];
  let i = 0;
  while (i < toks.length) {
    const raw = toks[i++]!;
    const status = raw[0]!;
    const n = status === "R" || status === "C" ? 2 : 1;
    const paths = toks.slice(i, i + n);
    i += n;
    if (paths.length) recs.push({ status, paths });
  }
  return recs;
}

/** The paths staged in `cwd`'s index — i.e. the files a just-completed clean
 * squash-merge landed as uncommitted changes. Captured so a red post-merge gate
 * can revert EXACTLY those paths (not a blanket reset that would nuke a
 * concurrent disjoint task's staged changes). A rename contributes BOTH its old
 * (deleted) and new (added) paths — reverting it means restoring one AND removing
 * the other; a copy contributes only its new path (the source is untouched). */
export async function gitStagedFiles(cwd: string, run: GitRunner = spawnGit): Promise<string[]> {
  const r = await run(cwd, ["diff", "--cached", "--name-status", "-z"]);
  if (!r.ok) return [];
  const out: string[] = [];
  for (const rec of parseNameStatusZ(r.stdout)) {
    if (rec.status === "R") out.push(...rec.paths); // old (deleted) + new (added)
    else if (rec.status === "C") out.push(rec.paths[1] ?? rec.paths[0]!); // only the new copy
    else out.push(rec.paths[0]!);
  }
  return [...new Set(out)];
}

/** Revert `files` (an uncommitted squash-merge whose post-merge gate went RED)
 * back to HEAD, leaving a clean main tree — touching ONLY the named paths so a
 * sibling task's disjoint changes survive. Handles all three change shapes:
 *   - unstage everything (index → HEAD for these paths),
 *   - restore tracked MODIFIED/DELETED files to HEAD content,
 *   - remove NEW files the merge added (they're not in HEAD, so `clean` deletes
 *     them; `checkout` alone would leave them as untracked cruft).
 * Each step tolerates the paths the others own (a `checkout` of a new path errors
 * harmlessly), so the combination fully reverts add/modify/delete. */
export async function gitRestoreFiles(
  cwd: string,
  files: string[],
  run: GitRunner = spawnGit,
): Promise<void> {
  if (!files.length) return;
  // Classify each staged path BEFORE touching the index: a NEW file (added, not
  // in HEAD) must be REMOVED, a MODIFIED/DELETED tracked file RESTORED from HEAD.
  // Critically, `git checkout HEAD -- <all>` ABORTS on the first path not in HEAD
  // (a new file), leaving the modified files unrestored — so the two shapes must
  // be reverted with separate commands over their own path sets.
  const wanted = new Set(files);
  const statusR = await run(cwd, ["diff", "--cached", "--name-status", "-z"]);
  const added: string[] = [];
  const tracked: string[] = [];
  if (statusR.ok) {
    for (const rec of parseNameStatusZ(statusR.stdout)) {
      if (rec.status === "R") {
        // rename = old path deleted-from-index (restore from HEAD) + new path added (remove).
        const [oldp, newp] = rec.paths;
        if (oldp && wanted.has(oldp)) tracked.push(oldp);
        if (newp && wanted.has(newp)) added.push(newp);
      } else if (rec.status === "C") {
        // copy = only the new path is added; the source is untouched in HEAD.
        const newp = rec.paths[1] ?? rec.paths[0];
        if (newp && wanted.has(newp)) added.push(newp);
      } else {
        const p = rec.paths[0];
        if (p && wanted.has(p)) (rec.status === "A" ? added : tracked).push(p);
      }
    }
  }
  await run(cwd, id(["reset", "--quiet", "--", ...files])); // unstage all
  if (tracked.length) await run(cwd, id(["checkout", "HEAD", "--", ...tracked])); // restore modified/deleted
  if (added.length) await run(cwd, id(["clean", "-fdq", "--", ...added])); // remove new files
}

/** Files changed vs a ref (a worktree branch's diff scope). */
export async function gitDiffSince(cwd: string, ref: string, run: GitRunner = spawnGit): Promise<string[]> {
  const r = await run(cwd, ["diff", "--name-only", ref]);
  return r.ok ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/**
 * Best-effort shell command to wipe an ecosystem's REGENERABLE build caches
 * before an authoritative cold build — or null when there's nothing safe to
 * clear. Only removes caches the next build regenerates — never source, never
 * `dist`/`build`/`out` (those can BE the deliverable), never `node_modules`.
 */
export function codeCacheCleanCommand(profile: RepoProfile): string | null {
  const paths: string[] = [];
  const isJs =
    profile.packageManager !== null ||
    profile.primaryLanguage === "TypeScript" ||
    profile.primaryLanguage === "JavaScript" ||
    profile.manifestFiles.some((f) => /(^|\/)package\.json$/.test(f));
  if (isJs) {
    paths.push(
      ".next", ".turbo", ".svelte-kit", ".astro", ".nuxt", ".cache", ".parcel-cache",
      "node_modules/.cache", "node_modules/.vite",
      "tsconfig.tsbuildinfo", "*.tsbuildinfo",
    );
  }
  const isPy =
    profile.primaryLanguage === "Python" ||
    profile.manifestFiles.some((f) => /(pyproject\.toml|setup\.py|requirements[^/]*\.txt)$/.test(f));
  if (isPy) paths.push(".mypy_cache", ".pytest_cache", ".ruff_cache");
  if (!paths.length) return null;
  return `rm -rf ${paths.join(" ")} 2>/dev/null; true`;
}
