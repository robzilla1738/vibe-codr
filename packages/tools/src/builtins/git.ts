import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@vibe/shared";

/** Run a git subcommand in the session cwd; returns combined output + exit code. */
async function git(args: string[], ctx: ToolContext): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: ctx.cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: ctx.abortSignal,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const out = (stdout + stderr).trim();
  return { code, out };
}

function cap(s: string, max = 20_000): string {
  return s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s;
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

const DiffInput = z.object({
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

export const gitDiffTool: ToolDefinition<z.infer<typeof DiffInput>> = {
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

const LogInput = z.object({
  max: z.number().int().positive().max(100).optional().describe("Number of commits to show (default 10)."),
  path: z.string().optional().describe("Limit history to this path."),
});

export const gitLogTool: ToolDefinition<z.infer<typeof LogInput>> = {
  name: "git_log",
  description: "Show recent commit history (hash, author, date, subject).",
  inputSchema: LogInput,
  readOnly: true,
  async execute({ max, path }, ctx) {
    const args = [
      "log",
      `-n${max ?? 10}`,
      "--pretty=format:%h %an %ad %s",
      "--date=short",
    ];
    if (path) args.push("--", path);
    const { code, out } = await git(args, ctx);
    if (code !== 0) return { output: out || "git log failed", isError: true };
    return { output: cap(out) || "(no commits yet)" };
  },
};

const PushInput = z.object({
  remote: z.string().optional().describe("Remote name (default: origin)."),
  branch: z.string().optional().describe("Branch to push (default: current branch)."),
  setUpstream: z
    .boolean()
    .optional()
    .describe("Pass -u to set the upstream tracking branch."),
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
    const args = ["push"];
    if (setUpstream) args.push("-u");
    args.push(remote ?? "origin", target);
    const { code, out } = await git(args, ctx);
    if (code !== 0) return { output: out || "git push failed", isError: true };
    return { output: out || `Pushed ${target} to ${remote ?? "origin"}.` };
  },
};

export const gitTools: ToolDefinition[] = [
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitPushTool,
];
