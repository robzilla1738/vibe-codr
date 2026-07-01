import { z } from "zod";
import { Glob } from "bun";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { ToolContext, ToolDefinition, ToolResult } from "@vibe/shared";

const Input = z.object({
  pattern: z.string().describe("Regex pattern to search for."),
  path: z.string().optional().describe("Directory or file to search."),
  glob: z.string().optional().describe('Filter files by glob, e.g. "*.ts".'),
  ignoreCase: z.boolean().optional().describe("Case-insensitive match."),
  context: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("Include N lines of context around each match (0-10)."),
  fileType: z
    .string()
    .optional()
    .describe('Restrict to a file type by extension, e.g. "ts" or "py".'),
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
    "Search file contents by regex (ripgrep when available, otherwise a built-in scan). Supports ignoreCase, context lines (0-10 around each match), a glob filter, and a fileType filter (e.g. \"ts\"). Returns matching lines with file:line prefixes. Inside a git repo the built-in fallback searches only tracked files (honoring .gitignore, like ripgrep).",
  inputSchema: Input,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx) {
    // Test/CI seam: force the dependency-free path even where `rg` is installed,
    // so the fallback is exercised deterministically (parity coverage).
    if (process.env.VIBE_GREP_NO_RIPGREP) return builtinGrep(input, ctx);
    try {
      return await ripgrepSearch(input, ctx);
    } catch {
      // ripgrep isn't available (not installed / sandboxed runner) — fall back to
      // a dependency-free scan so grep works everywhere.
      return builtinGrep(input, ctx);
    }
  },
};

/** Clamp the requested context window to the schema's 0-10 range (defensive:
 * the model can send an out-of-range or fractional value). */
function clampContext(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, Math.floor(n)));
}

/** ripgrep's known `--type` names, discovered once from `rg --type-list` and
 * cached for the process. Lets us pass `-t <type>` only when rg actually knows
 * the type and otherwise fall back to a `*.<ext>` glob (rather than making rg
 * exit 2 on an unknown type, which would surface as an error). */
let rgTypeCache: Set<string> | null = null;
async function ripgrepTypes(cwd: string): Promise<Set<string>> {
  if (rgTypeCache) return rgTypeCache;
  const types = new Set<string>();
  try {
    const proc = Bun.spawn(["rg", "--type-list"], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of out.split("\n")) {
      const name = line.split(":")[0]?.trim();
      if (name) types.add(name);
    }
  } catch {
    /* rg missing — leave the set empty; caller falls back to a glob */
  }
  rgTypeCache = types;
  return types;
}

/** Fast path: shell out to ripgrep. Throws if `rg` isn't on PATH (→ fallback). */
async function ripgrepSearch(
  { pattern, path, glob, ignoreCase, context, fileType }: GrepInput,
  ctx: ToolContext,
): Promise<ToolResult> {
  const args = ["rg", "--line-number", "--no-heading", "--color", "never"];
  if (ignoreCase) args.push("-i");
  const ctxN = clampContext(context);
  if (ctxN > 0) args.push("-C", String(ctxN));
  if (fileType) {
    const known = await ripgrepTypes(ctx.cwd);
    if (known.has(fileType)) args.push("-t", fileType);
    else args.push("--glob", `*.${fileType}`);
  }
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
  { pattern, path, glob, ignoreCase, context, fileType }: GrepInput,
  ctx: ToolContext,
): Promise<ToolResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (err) {
    return { output: `invalid regex: ${(err as Error).message}`, isError: true };
  }
  // A pattern with NO regex metacharacters is a plain literal — a substring scan
  // has no backtracking risk, so it can match ANY line length. Only a true regex
  // (which could backtrack catastrophically) is skipped on pathologically long
  // lines. This keeps the ReDoS guard while still finding literal symbols in a
  // minified/one-line file (the common fallback-grep case).
  const isLiteral = !/[.*+?^${}()|[\]\\]/.test(pattern);
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const ctxN = clampContext(context);
  const files = await listFiles(ctx.cwd, path ?? ".", glob, fileType);
  const results: string[] = [];
  let matchCount = 0;
  outer: for (const rel of files) {
    if (matchCount > LIMIT) break;
    if (ctx.abortSignal.aborted) break;
    let text: string;
    try {
      text = await Bun.file(join(ctx.cwd, rel)).text();
    } catch {
      continue; // unreadable / binary
    }
    const lines = text.split("\n");
    // First find every matching line index in this file.
    const matched: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (ctx.abortSignal.aborted) break outer;
      const line = lines[i]!;
      // Only a real regex risks catastrophic backtracking on a huge single line
      // (minified JS, embedded data) — skip those to avoid a synchronous hang. A
      // literal pattern is matched with a plain substring scan at any length.
      const hit = isLiteral
        ? (ignoreCase ? line.toLowerCase().includes(needle) : line.includes(needle))
        : line.length <= MAX_LINE_LEN && regex.test(line);
      if (hit) matched.push(i);
    }
    if (!matched.length) continue;
    // Expand each match by ±ctxN lines, merging overlaps into one ordered set.
    const isMatch = new Set(matched);
    const emit = new Set<number>();
    for (const m of matched) {
      const lo = Math.max(0, m - ctxN);
      const hi = Math.min(lines.length - 1, m + ctxN);
      for (let j = lo; j <= hi; j++) emit.add(j);
    }
    const ordered = [...emit].sort((a, b) => a - b);
    let prev = -2;
    for (const idx of ordered) {
      if (matchCount > LIMIT) break;
      // Separate non-contiguous context blocks with `--` (ripgrep parity).
      if (ctxN > 0 && prev >= 0 && idx > prev + 1) results.push("--");
      prev = idx;
      const sep = isMatch.has(idx) ? ":" : "-";
      results.push(`${rel}${sep}${idx + 1}${sep}${lines[idx]}`);
      if (isMatch.has(idx)) matchCount++;
    }
  }
  return capResults(results);
}

/** Enumerate files to scan: a single file, or every tracked/walked file under a
 * directory, filtered by glob + fileType + a binary-extension skip. */
async function listFiles(
  cwd: string,
  root: string,
  glob: string | undefined,
  fileType: string | undefined,
): Promise<string[]> {
  const info = await stat(join(cwd, root)).catch(() => null);
  if (info?.isFile()) return [root];
  // Prefer git-tracked files so the fallback honors .gitignore basics (parity
  // with ripgrep, which respects .gitignore). Outside a git repo, walk the tree.
  const tracked = await gitTrackedFiles(cwd, root);
  const raw = tracked ?? (await walkFiles(cwd, root));
  return filterFiles(raw, glob, fileType);
}

/** Files git tracks under `root` (honors .gitignore, skips untracked), or null
 * when this isn't a git repo / git is unavailable (→ caller walks the tree). */
async function gitTrackedFiles(cwd: string, root: string): Promise<string[] | null> {
  try {
    const sub = root === "." || root === "" ? "." : root;
    const proc = Bun.spawn(["git", "ls-files", "-z", "--", sub], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    // Exit 0 means we ARE in a git repo: return the tracked set (possibly empty
    // — an empty result deliberately means "nothing tracked here", NOT "walk").
    if ((await proc.exited) === 0) return out.split("\0").filter(Boolean);
  } catch {
    /* git missing — fall through to the filesystem walk */
  }
  return null;
}

/** Filesystem walk (used outside a git repo): every file under `root`, minus the
 * usual dependency/VCS dirs, bounded so a huge tree can't run away. */
async function walkFiles(cwd: string, root: string): Promise<string[]> {
  const base = root === "." || root === "" ? "" : `${root.replace(/\/+$/, "")}/`;
  const files: string[] = [];
  try {
    for await (const f of new Glob(`${base}**/*`).scan({ cwd, onlyFiles: true, dot: false })) {
      files.push(f);
      if (files.length >= 20_000) break; // bound the scan
    }
  } catch {
    /* unreadable directory — return what we have */
  }
  return files;
}

/** Apply the glob / fileType / binary filters uniformly to a candidate set,
 * whether it came from `git ls-files` or the filesystem walk. */
function filterFiles(files: string[], glob: string | undefined, fileType: string | undefined): string[] {
  const matchGlob = glob ? makeGlobMatcher(glob) : null;
  const out: string[] = [];
  for (const f of files) {
    if (f.includes("node_modules/") || f === ".git" || f.startsWith(".git/")) continue;
    if (BINARY_EXT.test(f)) continue;
    if (fileType && !f.endsWith(`.${fileType}`)) continue;
    if (matchGlob && !matchGlob(f)) continue;
    out.push(f);
  }
  return out;
}

/** A glob predicate that matches either the full relative path or the basename,
 * so a plain "*.ts" matches "a.ts" AND "src/a.ts" (the pre-unification behavior
 * used a recursive prefix), while a rooted "src/..." glob still matches by path. */
function makeGlobMatcher(pattern: string): (rel: string) => boolean {
  const g = new Glob(pattern);
  return (rel) => g.match(rel) || g.match(rel.slice(rel.lastIndexOf("/") + 1));
}

/** Test hook: drop the cached `rg --type-list` result between tests. */
export function _resetRipgrepTypeCache(): void {
  rgTypeCache = null;
}

/** Apply the match cap + truncation marker (shared by both paths). */
function capResults(lines: string[]): ToolResult {
  const truncated = lines.length > LIMIT;
  const capped = lines.slice(0, LIMIT).join("\n");
  if (!capped) return { output: "(no matches)" };
  return { output: truncated ? `${capped}\n…(truncated at ${LIMIT} matches)` : capped };
}
