import { z } from "zod";
import { Glob } from "bun";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { ToolContext, ToolDefinition, ToolResult } from "@vibe/shared";

const Input = z.object({
  pattern: z.string().describe("Regex pattern to search for."),
  path: z.string().optional().describe("Directory or file to search."),
  glob: z.string().optional().describe('Filter files by glob, e.g. "*.ts".'),
});

type GrepInput = z.infer<typeof Input>;

/** Cap on returned match lines, so a broad pattern can't flood the context. */
const LIMIT = 500;
/** Skip lines longer than this in the builtin fallback scan: a user regex with
 * catastrophic backtracking against a very long single line (minified JS, a data
 * blob) would otherwise hang synchronously and ignore the abort signal. */
const MAX_LINE_LEN = 50_000;

/** Extensions we never scan in the built-in fallback (binary / non-text). */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|bz2|7z|exe|dll|so|dylib|wasm|sqlite|db|bin|o|a|class|jar|mp[34]|mov|woff2?|ttf|eot|lock)$/i;

export const grepTool: ToolDefinition<GrepInput> = {
  name: "grep",
  description:
    "Search file contents by regex (ripgrep when available, otherwise a built-in scan). Returns matching lines with file:line prefixes.",
  inputSchema: Input,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx) {
    try {
      return await ripgrepSearch(input, ctx);
    } catch {
      // ripgrep isn't available (not installed / sandboxed runner) — fall back to
      // a dependency-free scan so grep works everywhere.
      return builtinGrep(input, ctx);
    }
  },
};

/** Fast path: shell out to ripgrep. Throws if `rg` isn't on PATH (→ fallback). */
async function ripgrepSearch({ pattern, path, glob }: GrepInput, ctx: ToolContext): Promise<ToolResult> {
  const args = ["rg", "--line-number", "--no-heading", "--color", "never"];
  if (glob) args.push("--glob", glob);
  // `--` terminates option parsing so a pattern/path beginning with `-` is a term.
  args.push("--", pattern, path ?? ".");
  const proc = Bun.spawn(args, {
    cwd: ctx.cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: ctx.abortSignal,
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code === 1) return { output: "(no matches)" };
  if (code > 1) {
    const err = await new Response(proc.stderr).text();
    return { output: `ripgrep error: ${err}`, isError: true };
  }
  const lines = out.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return capResults(lines);
}

/** Fallback: a built-in regex scan over the tracked/globbed files. */
export async function builtinGrep(
  { pattern, path, glob }: GrepInput,
  ctx: ToolContext,
): Promise<ToolResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    return { output: `invalid regex: ${(err as Error).message}`, isError: true };
  }
  // A pattern with NO regex metacharacters is a plain literal — a substring scan
  // has no backtracking risk, so it can match ANY line length. Only a true regex
  // (which could backtrack catastrophically) is skipped on pathologically long
  // lines. This keeps the ReDoS guard while still finding literal symbols in a
  // minified/one-line file (the common fallback-grep case).
  const isLiteral = !/[.*+?^${}()|[\]\\]/.test(pattern);
  const files = await listFiles(ctx.cwd, path ?? ".", glob);
  const results: string[] = [];
  for (const rel of files) {
    if (results.length > LIMIT) break;
    if (ctx.abortSignal.aborted) break;
    let text: string;
    try {
      text = await Bun.file(join(ctx.cwd, rel)).text();
    } catch {
      continue; // unreadable / binary
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (ctx.abortSignal.aborted) break;
      const line = lines[i]!;
      // Only a real regex risks catastrophic backtracking on a huge single line
      // (minified JS, embedded data) — skip those to avoid a synchronous hang. A
      // literal pattern is matched with a plain substring scan at any length.
      const matched = isLiteral
        ? line.includes(pattern)
        : line.length <= MAX_LINE_LEN && regex.test(line);
      if (matched) {
        results.push(`${rel}:${i + 1}:${line}`);
        if (results.length > LIMIT) break;
      }
    }
  }
  return capResults(results);
}

/** Enumerate files to scan: a single file, or a glob under a directory. */
async function listFiles(cwd: string, root: string, glob: string | undefined): Promise<string[]> {
  const info = await stat(join(cwd, root)).catch(() => null);
  if (info?.isFile()) return [root];
  const base = root === "." || root === "" ? "" : `${root.replace(/\/+$/, "")}/`;
  const pattern = glob ? `${base}**/${glob}` : `${base}**/*`;
  const files: string[] = [];
  try {
    for await (const f of new Glob(pattern).scan({ cwd, onlyFiles: true, dot: false })) {
      if (f.includes("node_modules/") || f.startsWith(".git/") || BINARY_EXT.test(f)) continue;
      files.push(f);
      if (files.length >= 20_000) break; // bound the scan
    }
  } catch {
    /* unreadable directory — return what we have */
  }
  return files;
}

/** Apply the match cap + truncation marker (shared by both paths). */
function capResults(lines: string[]): ToolResult {
  const truncated = lines.length > LIMIT;
  const capped = lines.slice(0, LIMIT).join("\n");
  if (!capped) return { output: "(no matches)" };
  return { output: truncated ? `${capped}\n…(truncated at ${LIMIT} matches)` : capped };
}
