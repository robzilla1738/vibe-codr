/**
 * Git IPC handlers for the Electron main process.
 *
 * Registers `git:*` IPC channels that the renderer calls through `window.vibe`
 * to manage branches, commits, and remotes. All operations spawn `git` directly
 * — the engine is never involved.
 */

import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import type { Readable } from "node:stream";
import { ipcMain } from "electron";
import { isAllowedCwd } from "../shared/cwd-allowlist";
import { safeExternalUrl } from "../shared/external-url";
import {
  checkoutBranch,
  commit,
  createBranch,
  deleteBranch,
  fetchRemotes,
  getFullStatus,
  getWorkingTreeFileDiff,
  isGitRepo,
  mergeBranch,
  pullBranch,
  pushBranch,
  stageAll,
  stageFiles,
  unstageAll,
  unstageFiles,
} from "../shared/git-ops";
import {
  type GhPrCreateRequest,
  type GhPrCreateResult,
  type GhPrListResult,
  type GitCheckoutRequest,
  type GitCommitRequest,
  type GitCreateBranchRequest,
  type GitDeleteBranchRequest,
  type GitMergeRequest,
  type GitPullRequest,
  type GitPushRequest,
  parseGhPrList,
  validateGhPrCreateRequest,
} from "../shared/git-types";
import { resolveWritablePathInsideRoot } from "../shared/path-safe";
import {
  appendCapture,
  captureOverflowError,
  createCaptureBuffers,
  DEFAULT_CAPTURE_MAX_BYTES,
} from "../shared/stream-cap";
import { enrichedEnv } from "./host-resolver";
import type { AssertTrustedIpc } from "./ipc-security";

function rejectCwd(cwd: unknown): { ok: false; error: string } | null {
  if (typeof cwd !== "string" || !cwd) return { ok: false, error: "cwd required" };
  if (!isAllowedCwd(cwd)) return { ok: false, error: "cwd is not an opened project root" };
  return null;
}

interface SpawnedChild {
  stdout: Readable;
  stderr: Readable;
  kill(signal?: string): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close", cb: (code: number | null) => void): void;
}

function spawnGh(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, {
      cwd,
      env: enrichedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as SpawnedChild;
    const capture = createCaptureBuffers(DEFAULT_CAPTURE_MAX_BYTES);
    let forceTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;
    let timedOut = false;
    let settled = false;
    const finish = (result: { ok: boolean; stdout: string; stderr: string }) => {
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
            stderr: capture.stderr || "gh command timed out",
          });
        }, 2_000);
      }, 2_000);
    }, 30_000);
    const clearTimers = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    child.stdout.on("data", (c: Buffer) => appendCapture(capture, "stdout", c));
    child.stderr.on("data", (c: Buffer) => appendCapture(capture, "stderr", c));
    child.on("error", () => {
      finish({ ok: false, stdout: capture.stdout, stderr: "gh CLI not found" });
    });
    child.on("close", (code: number | null) => {
      if (capture.truncated) {
        finish({
          ok: false,
          stdout: capture.stdout,
          stderr: captureOverflowError(capture, "gh output"),
        });
        return;
      }
      finish({
        ok: !timedOut && code === 0,
        stdout: capture.stdout,
        stderr: timedOut
          ? capture.stderr || "gh command timed out"
          : capture.stderr,
      });
    });
  });
}

export function registerGitIpc(assertTrusted: AssertTrustedIpc): void {
  ipcMain.handle("git:status", async (event, cwd: string) => {
    assertTrusted(event);
    const bad = rejectCwd(cwd);
    if (bad) return bad;
    try {
      if (!(await isGitRepo(cwd))) {
        return { ok: true as const, status: null };
      }
      const status = await getFullStatus(cwd);
      return { ok: true as const, status };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:fileDiff", async (event, opts: { cwd: string; path: string }) => {
    assertTrusted(event);
    if (!opts || typeof opts.cwd !== "string" || typeof opts.path !== "string") {
      return { ok: false as const, error: "Invalid request" };
    }
    const bad = rejectCwd(opts.cwd);
    if (bad) return bad;
    const located = resolveWritablePathInsideRoot(opts.cwd, opts.path, {
      existsSync,
      lstatSync,
      realpathSync,
    });
    if (!located.ok) return { ok: false as const, error: located.error };
    return getWorkingTreeFileDiff(located.target);
  });

  ipcMain.handle("git:createBranch", async (event, req: GitCreateBranchRequest) => {
    assertTrusted(event);
    if (!req || typeof req.cwd !== "string" || typeof req.name !== "string") {
      return { ok: false as const, error: "Invalid request" };
    }
    const bad = rejectCwd(req.cwd);
    if (bad) return bad;
    const result = await createBranch(req.cwd, req.name, req.from, req.checkout);
    return { ok: result.ok, message: result.message, error: result.ok ? undefined : result.stderr || "Failed" };
  });

  ipcMain.handle("git:checkout", async (event, req: GitCheckoutRequest) => {
    assertTrusted(event);
    if (!req || typeof req.cwd !== "string" || typeof req.name !== "string") {
      return { ok: false as const, error: "Invalid request" };
    }
    const bad = rejectCwd(req.cwd);
    if (bad) return bad;
    const result = await checkoutBranch(req.cwd, req.name, req.track);
    return { ok: result.ok, message: result.message, error: result.ok ? undefined : result.stderr || "Failed" };
  });

  ipcMain.handle("git:deleteBranch", async (event, req: GitDeleteBranchRequest) => {
    assertTrusted(event);
    if (!req || typeof req.cwd !== "string" || typeof req.name !== "string") {
      return { ok: false as const, error: "Invalid request" };
    }
    const bad = rejectCwd(req.cwd);
    if (bad) return bad;
    const result = await deleteBranch(req.cwd, req.name, req.force);
    return { ok: result.ok, message: result.message, error: result.ok ? undefined : result.stderr || "Failed" };
  });

  ipcMain.handle("git:stage", async (event, opts: { cwd: string; paths?: string[]; all?: boolean; allIncludingUntracked?: boolean }) => {
    assertTrusted(event);
    if (!opts || typeof opts.cwd !== "string") {
      return { ok: false as const, error: "Invalid request" };
    }
    const bad = rejectCwd(opts.cwd);
    if (bad) return bad;
    let result: { ok: boolean; stdout: string; stderr: string; message?: string };
    if (opts.all || opts.allIncludingUntracked) {
      result = await stageAll(opts.cwd, opts.allIncludingUntracked ?? false);
    } else if (opts.paths && opts.paths.length > 0) {
      result = await stageFiles(opts.cwd, opts.paths);
    } else {
      // Do not treat empty stage as "unstage all" — that is git:unstage.
      return { ok: false as const, error: "paths, all, or allIncludingUntracked required" };
    }
    return { ok: result.ok, message: result.message, error: result.ok ? undefined : result.stderr || "Failed" };
  });

  ipcMain.handle("git:unstage", async (event, opts: { cwd: string; paths?: string[] }) => {
    assertTrusted(event);
    if (!opts || typeof opts.cwd !== "string") {
      return { ok: false as const, error: "Invalid request" };
    }
    const bad = rejectCwd(opts.cwd);
    if (bad) return bad;
    const result =
      opts.paths && opts.paths.length > 0
        ? await unstageFiles(opts.cwd, opts.paths)
        : await unstageAll(opts.cwd);
    return { ok: result.ok, message: result.message, error: result.ok ? undefined : result.stderr || "Failed" };
  });

  ipcMain.handle("git:commit", async (event, req: GitCommitRequest) => {
    assertTrusted(event);
    if (!req || typeof req.cwd !== "string" || typeof req.message !== "string") {
      return { ok: false as const, error: "Invalid request" };
    }
    const bad = rejectCwd(req.cwd);
    if (bad) return bad;
    const result = await commit(req.cwd, req.message, {
      stageAll: req.stageAll,
      stageAllIncludingUntracked: req.stageAllIncludingUntracked,
      amend: req.amend,
    });
    return { ok: result.ok, message: result.message, error: result.ok ? undefined : result.stderr || "Failed" };
  });

  ipcMain.handle("git:merge", async (event, req: GitMergeRequest) => {
    assertTrusted(event);
    if (!req || typeof req.cwd !== "string" || typeof req.branch !== "string") {
      return { ok: false as const, error: "Invalid request" };
    }
    const bad = rejectCwd(req.cwd);
    if (bad) return bad;
    const result = await mergeBranch(req.cwd, req.branch, req.noFastForward);
    return { ok: result.ok, message: result.message, error: result.ok ? undefined : result.stderr || "Failed" };
  });

  ipcMain.handle("git:push", async (event, req: GitPushRequest) => {
    assertTrusted(event);
    if (!req || typeof req.cwd !== "string") {
      return { ok: false as const, error: "Invalid request" };
    }
    const bad = rejectCwd(req.cwd);
    if (bad) return bad;
    const result = await pushBranch(req.cwd, {
      remote: req.remote,
      branch: req.branch,
      setUpstream: req.setUpstream,
      force: req.force,
    });
    return { ok: result.ok, message: result.message, error: result.ok ? undefined : result.stderr || "Failed" };
  });

  ipcMain.handle("git:pull", async (event, req: GitPullRequest) => {
    assertTrusted(event);
    if (!req || typeof req.cwd !== "string") {
      return { ok: false as const, error: "Invalid request" };
    }
    const bad = rejectCwd(req.cwd);
    if (bad) return bad;
    const result = await pullBranch(req.cwd, { remote: req.remote, branch: req.branch });
    return { ok: result.ok, message: result.message, error: result.ok ? undefined : result.stderr || "Failed" };
  });

  ipcMain.handle("git:fetch", async (event, opts: { cwd: string; remote?: string }) => {
    assertTrusted(event);
    if (!opts || typeof opts.cwd !== "string") {
      return { ok: false as const, error: "Invalid request" };
    }
    const bad = rejectCwd(opts.cwd);
    if (bad) return bad;
    const result = await fetchRemotes(opts.cwd, opts.remote);
    return { ok: result.ok, message: result.message, error: result.ok ? undefined : result.stderr || "Failed" };
  });

  // ── GitHub CLI (gh) integration ──────────────────────────────────────

  ipcMain.handle("gh:checkAvailable", async (event) => {
    assertTrusted(event);
    const res = await spawnGh(process.cwd(), ["--version"]);
    return { available: res.ok };
  });

  ipcMain.handle("gh:prList", async (event, cwd: string) => {
    assertTrusted(event);
    const bad = rejectCwd(cwd);
    if (bad) return { ok: false as const, prs: [], error: bad.error } as GhPrListResult;
    try {
      const res = await spawnGh(cwd, ["pr", "list", "--json", "number,title,state,headRefName,url", "--limit", "20"]);
      if (!res.ok) {
        return { ok: false as const, prs: [], error: res.stderr || "gh command failed" } as GhPrListResult;
      }
      const data = parseGhPrList(JSON.parse(res.stdout) as unknown);
      if (!data) {
        return { ok: false as const, prs: [], error: "gh returned an invalid pull-request list" } as GhPrListResult;
      }
      return {
        ok: true as const,
        prs: data,
      } as GhPrListResult;
    } catch (err) {
      return { ok: false as const, prs: [], error: err instanceof Error ? err.message : String(err) } as GhPrListResult;
    }
  });

  ipcMain.handle("gh:prCreate", async (event, req: GhPrCreateRequest) => {
    assertTrusted(event);
    if (!validateGhPrCreateRequest(req)) {
      return { ok: false as const, error: "Invalid request" } as GhPrCreateResult;
    }
    const bad = rejectCwd(req.cwd);
    if (bad) return { ok: false as const, error: bad.error } as GhPrCreateResult;
    try {
      const args = ["pr", "create", "--title", req.title];
      if (req.body) { args.push("--body", req.body); }
      if (req.base) { args.push("--base", req.base); }
      if (req.head) { args.push("--head", req.head); }
      if (req.draft) { args.push("--draft"); }
      if (req.web) { args.push("--web"); }
      const res = await spawnGh(req.cwd, args);
      if (!res.ok) {
        return { ok: false as const, error: res.stderr || "gh pr create failed" } as GhPrCreateResult;
      }
      const outputUrl = res.stdout.trim().split("\n")[0] || undefined;
      const url = outputUrl ? safeExternalUrl(outputUrl) : undefined;
      if (outputUrl && !url) {
        return { ok: false as const, error: "gh returned an invalid pull-request URL" } as GhPrCreateResult;
      }
      return { ok: true as const, url, message: res.ok ? "PR created" : undefined } as GhPrCreateResult;
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) } as GhPrCreateResult;
    }
  });
}
