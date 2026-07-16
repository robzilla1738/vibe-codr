import { z } from "zod";
import { capText, omittedMarker, readCappedText } from "@vibe/shared";
import type { ToolContext, ToolDefinition } from "@vibe/shared";
import { withPathAliases } from "../path-input.ts";

/** Ceiling on chars read from each git stream, well above the 20k display cap so
 * nothing legitimate is lost — but bounded so a pathological `git diff` of a
 * multi-GB change can't be fully materialized in memory before `cap()` trims it.
 * Kept as head+tail: git output whose tail matters (a diff's last hunk, an error
 * printed last) must survive to the display cap, which is itself head+tail. */
const MAX_GIT_STREAM = 64_000;
/** Wall-clock bound on a git spawn so a lock-waiting or network git (fetch/pull
 * on a hung remote, `index.lock` contention) can't wait forever short of Esc.
 * Generous — a large local op is legitimately slow. Unlike bash.ts, git here
 * spawns no tree worth killing, so the direct signal (SIGTERM on the child) is
 * enough. */
const GIT_TIMEOUT_MS = 120_000;

/** Run a git subcommand in the session cwd; returns combined output + exit code. */
async function git(args: string[], ctx: ToolContext): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: ctx.cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(GIT_TIMEOUT_MS)]),
  });
  const capOpts = { cap: MAX_GIT_STREAM, keep: "head+tail" as const, marker: omittedMarker };
  const [stdout, stderr, code] = await Promise.all([
    readCappedText(proc.stdout, capOpts),
    readCappedText(proc.stderr, capOpts),
    proc.exited,
  ]);
  const out = (stdout.text + stderr.text).trim();
  return { code, out };
}

/** Model-facing display cap for diff/log output. Head+tail so a huge diff still
 * shows both its start and its end (where a conflict/error tends to land). */
function cap(s: string): string {
  return capText(s, { cap: 20_000, keep: "head+tail", marker: omittedMarker });
}

export const gitStatusTool: ToolDefinition<Record<string, never>> = {
  name: "git_status",
  description: "Show the working-tree status (porcelain) and current branch.",
  inputSchema: z.object({}),
  readOnly: true,
  async execute(_input, ctx) {
    const { code, out } = await git(["status", "--porcelain=v1", "--branch"], ctx);
    if (code !== 0) return { output: out || "git status failed", isError: true };
    // `--branch` always prints a `## <branch>` header; a tree is clean when no
    // file-status lines follow it.
    const fileLines = out.split("\n").filter((l) => l && !l.startsWith("##"));
    if (!fileLines.length) return { output: `${out}\n(clean working tree)` };
    return { output: out };
  },
};

const DiffInput = withPathAliases({
  staged: z.boolean().optional().describe("Show staged (index) changes instead of unstaged."),
  ref: z
    .string()
    .optional()
    .describe(
      "Diff against a commit/branch/range instead of the working tree — e.g. " +
        "'HEAD' (all uncommitted tracked changes), 'main', a commit hash, or a " +
        "range like 'main...HEAD' (a branch's commits). Combine with path to scope.",
    ),
  path: z.string().optional().describe("Limit the diff to this path."),
});

export const gitDiffTool: ToolDefinition<z.output<typeof DiffInput>> = {
  name: "git_diff",
  description:
    "Show a git diff. Defaults to unstaged changes; staged:true shows the index, " +
    "and ref:'HEAD'/'main'/'<sha>'/'main...HEAD' diffs against a commit, branch, or range.",
  inputSchema: DiffInput,
  readOnly: true,
  async execute({ staged, ref, path }, ctx) {
    // A ref starting with '-' would be parsed as an option (e.g. injecting
    // `--output`); reject it rather than hand git an ambiguous flag.
    if (ref?.startsWith("-")) {
      return { output: `Invalid ref "${ref}".`, isError: true };
    }
    const args = ["diff"];
    if (staged) args.push("--staged");
    if (ref) args.push(ref);
    if (path) args.push("--", path);
    const { code, out } = await git(args, ctx);
    if (code !== 0) return { output: out || "git diff failed", isError: true };
    return { output: cap(out) || "(no changes)" };
  },
};

const CommitInput = z.object({
  message: z.string().describe("Commit message."),
  all: z.boolean().optional().describe("Stage all tracked changes (git add -A) before committing."),
});

export const gitCommitTool: ToolDefinition<z.infer<typeof CommitInput>> = {
  name: "git_commit",
  description:
    "Create a git commit. With all:true, stages every change first (git add -A). Returns the new commit summary.",
  inputSchema: CommitInput,
  readOnly: false,
  concurrencySafe: false,
  async execute({ message, all }, ctx) {
    if (all) {
      const add = await git(["add", "-A"], ctx);
      if (add.code !== 0) return { output: add.out || "git add failed", isError: true };
    }
    const { code, out } = await git(["commit", "-m", message], ctx);
    if (code !== 0) {
      return { output: out || "git commit failed (nothing staged?)", isError: true };
    }
    return { output: out };
  },
};

const LogInput = withPathAliases({
  max: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Number of commits to show (default 10)."),
  path: z.string().optional().describe("Limit history to this path."),
});

export const gitLogTool: ToolDefinition<z.output<typeof LogInput>> = {
  name: "git_log",
  description: "Show recent commit history (hash, author, date, subject).",
  inputSchema: LogInput,
  readOnly: true,
  async execute({ max, path }, ctx) {
    const args = ["log", `-n${max ?? 10}`, "--pretty=format:%h %an %ad %s", "--date=short"];
    if (path) args.push("--", path);
    const { code, out } = await git(args, ctx);
    if (code !== 0) return { output: out || "git log failed", isError: true };
    return { output: cap(out) || "(no commits yet)" };
  },
};

const PushInput = z.object({
  remote: z.string().optional().describe("Remote name (default: origin)."),
  branch: z.string().optional().describe("Branch to push (default: current branch)."),
  setUpstream: z.boolean().optional().describe("Pass -u to set the upstream tracking branch."),
});

export const gitPushTool: ToolDefinition<z.infer<typeof PushInput>> = {
  name: "git_push",
  description:
    "Push commits to a remote (default origin / current branch). Use after git_commit to publish work to GitHub.",
  inputSchema: PushInput,
  readOnly: false,
  concurrencySafe: false,
  async execute({ remote, branch, setUpstream }, ctx) {
    // Resolve the current branch when none is given so `-u` has a target.
    let target = branch;
    if (!target) {
      const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], ctx);
      if (head.code !== 0) return { output: head.out || "cannot resolve HEAD", isError: true };
      target = head.out.trim();
    }
    // BUG-054: reject dash-prefixed remote/branch so values like `--force` or
    // `--mirror` cannot be parsed as git options. Same class as git_diff's ref
    // guard. Pass `--` before positionals so refspecs cannot smuggle flags.
    const remoteName = remote ?? "origin";
    if (remoteName.startsWith("-") || target.startsWith("-")) {
      return {
        output:
          "git_push: remote and branch must not start with '-' (refusing option-like values). " +
          "Use a plain remote name and branch ref.",
        isError: true,
      };
    }
    // Block force/delete refspec forms unless the user uses a real git shell
    // command under permission review.
    if (target.startsWith(":") || target.startsWith("+") || target.includes(":")) {
      return {
        output:
          "git_push: refspec force/delete forms (leading '+', ':', or 'src:dst') are not allowed. " +
          "Push a plain branch name.",
        isError: true,
      };
    }
    const args = ["push"];
    if (setUpstream) args.push("-u");
    args.push("--", remoteName, target);
    const { code, out } = await git(args, ctx);
    if (code !== 0) return { output: out || "git push failed", isError: true };
    return { output: out || `Pushed ${target} to ${remoteName}.` };
  },
};

export const gitTools: ToolDefinition[] = [
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitPushTool,
];
