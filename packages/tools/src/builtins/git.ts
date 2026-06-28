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
  path: z.string().optional().describe("Limit the diff to this path."),
});

export const gitDiffTool: ToolDefinition<z.infer<typeof DiffInput>> = {
  name: "git_diff",
  description: "Show the git diff of unstaged (or, with staged:true, staged) changes.",
  inputSchema: DiffInput,
  readOnly: true,
  async execute({ staged, path }, ctx) {
    const args = ["diff"];
    if (staged) args.push("--staged");
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

export const gitTools: ToolDefinition[] = [gitStatusTool, gitDiffTool, gitCommitTool];
