/**
 * Git operation types for the Electron shell's GitHub/branch integration panel.
 *
 * All git operations are performed by the Electron main process spawning `git`
 * directly — these are shell-level operations, NOT engine commands. The engine
 * remains the sole authority for agent-loop work; this panel manages the working
 * tree's branch state the way a developer would at the terminal.
 */

import { safeExternalUrl } from "./external-url";

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  /** Upstream tracking branch, if any (e.g. "origin/main"). */
  upstream?: string;
  /** Commits ahead of upstream (0 when no upstream). */
  ahead?: number;
  /** Commits behind upstream (0 when no upstream). */
  behind?: number;
  /** Last commit subject on this branch. */
  lastSubject?: string;
  /** Last commit date (epoch ms). */
  lastDate?: number;
}

export interface GitRemote {
  name: string;
  url: string;
  /** Normalized host for display (e.g. "github.com"). */
  host?: string;
  /** Owner/repo extracted from the URL, when available. */
  owner?: string;
  repo?: string;
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: number;
  subject: string;
}

export interface GitStatusEntry {
  /** Porcelain status code (e.g. "M", "A", "D", "??", "R"). */
  index: string;
  /** Working-tree status code. */
  working: string;
  path: string;
  /** Original path for renames. */
  oldPath?: string;
}

export interface GitStatusResult {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  clean: boolean;
  entries: GitStatusEntry[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
}

export interface GitFullStatus extends GitStatusResult {
  remotes: GitRemote[];
  branches: GitBranch[];
  recentCommits: GitCommitInfo[];
}

export type GitFileDiffResult =
  | { ok: true; available: false }
  | {
      ok: true;
      available: true;
      diff: string;
      added: number;
      removed: number;
    }
  | { ok: false; error: string };

// ── Operation request/result types ───────────────────────────────────────

export interface GitCreateBranchRequest {
  cwd: string;
  name: string;
  /** Base branch/commit to branch from. Defaults to HEAD. */
  from?: string;
  /** Checkout the new branch after creating it. */
  checkout?: boolean;
}

export interface GitCheckoutRequest {
  cwd: string;
  name: string;
  /** Create the local branch from upstream if it doesn't exist. */
  track?: boolean;
}

export interface GitDeleteBranchRequest {
  cwd: string;
  name: string;
  force?: boolean;
}

export interface GitCommitRequest {
  cwd: string;
  message: string;
  /** Stage all tracked changes before committing (git add -u). */
  stageAll?: boolean;
  /** Also stage untracked files (git add -A). */
  stageAllIncludingUntracked?: boolean;
  /** Amend the previous commit instead of creating a new one. */
  amend?: boolean;
}

export interface GitMergeRequest {
  cwd: string;
  branch: string;
  /** Create a merge commit even when fast-forward is possible. */
  noFastForward?: boolean;
}

export interface GitPushRequest {
  cwd: string;
  /** Remote name. Defaults to "origin". */
  remote?: string;
  /** Branch to push. Defaults to current. */
  branch?: string;
  /** Set upstream tracking on first push. */
  setUpstream?: boolean;
  force?: boolean;
}

export interface GitPullRequest {
  cwd: string;
  remote?: string;
  branch?: string;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Human-readable summary for a toast. */
  message?: string;
}

export interface GhPrCreateRequest {
  cwd: string;
  title: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
  web?: boolean;
}

export interface GhPrCreateResult {
  ok: boolean;
  url?: string;
  message?: string;
  error?: string;
}

export interface GhPrListResult {
  ok: boolean;
  prs: GhPrSummary[];
  error?: string;
}

export interface GhPrSummary {
  number: number;
  title: string;
  state: string;
  head: string;
  url: string;
}

const GH_PR_TITLE_MAX_CHARS = 1_024;
const GH_PR_BODY_MAX_CHARS = 64 * 1_024;
const GH_REF_MAX_CHARS = 1_024;

/** Validate the renderer-to-main PR request before building process arguments. */
export function validateGhPrCreateRequest(value: unknown): value is GhPrCreateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (typeof request.cwd !== "string" || !request.cwd) return false;
  if (
    typeof request.title !== "string"
    || !request.title.trim()
    || request.title.length > GH_PR_TITLE_MAX_CHARS
    || /\p{Cc}/u.test(request.title)
  ) return false;
  if (!optionalBoundedText(request.body, GH_PR_BODY_MAX_CHARS, true)) return false;
  if (!optionalBoundedText(request.base, GH_REF_MAX_CHARS, false)) return false;
  if (!optionalBoundedText(request.head, GH_REF_MAX_CHARS, false)) return false;
  if (request.draft !== undefined && typeof request.draft !== "boolean") return false;
  if (request.web !== undefined && typeof request.web !== "boolean") return false;
  return true;
}

function optionalBoundedText(value: unknown, maxChars: number, allowNewlines: boolean): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || !value.trim() || value.length > maxChars) return false;
  for (const character of value) {
    if (allowNewlines && (character === "\t" || character === "\n" || character === "\r")) {
      continue;
    }
    if (/\p{Cc}/u.test(character)) return false;
  }
  return true;
}

/** Validate the untrusted JSON emitted by the external `gh` process. */
export function parseGhPrList(value: unknown): GhPrSummary[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const parsed: GhPrSummary[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const item = candidate as Record<string, unknown>;
    if (!Number.isInteger(item.number) || (item.number as number) <= 0) return null;
    if (typeof item.title !== "string" || item.title.length > 4096) return null;
    if (typeof item.state !== "string" || !item.state || item.state.length > 64) return null;
    if (typeof item.headRefName !== "string" || item.headRefName.length > 1024) return null;
    if (typeof item.url !== "string" || item.url.length > 4096) return null;
    const url = safeExternalUrl(item.url);
    if (!url) return null;
    parsed.push({
      number: item.number as number,
      title: item.title,
      state: item.state,
      head: item.headRefName,
      url,
    });
  }
  return parsed;
}
