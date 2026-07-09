import { z } from "zod";
import { Glob } from "bun";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { ToolContext, ToolDefinition, ToolResult } from "@vibe/shared";
import { withPathAliases } from "../path-input.ts";

const Input = withPathAliases({
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

type GrepInput = z.output<typeof Input>;

/** Cap on returned match lines, so a broad pattern can't flood the context. */
const LIMIT = 500;
/** Skip lines longer than this in the builtin fallback scan: a user regex with
 * catastrophic backtracking against a very long single line (minified JS, a data
 * blob) would otherwise hang synchronously and ignore the abort signal. */
const MAX_LINE_LEN = 50_000;
/** Maximum single file size the dependency-free fallback will read into memory.
 * Ripgrep is the preferred path for large files; when it is unavailable, this
 * cap prevents one huge candidate from OOMing the tool process. */
const MAX_FALLBACK_FILE_BYTES = 10 * 1024 * 1024;

/** Multi-extension `fileType` sets mirroring ripgrep's `--type` definitions, so
 * the fallback's `fileType:"ts"` matches .ts/.tsx/.mts/.cts (not just literal
 * .ts) — matching the rg path's `-t ts`. Without this, `fileType:"ts"` with rg
 * unavailable silently skips every .tsx file → "(no matches)" → the model wrongly
 * concludes the symbol is absent. An unmapped type keeps single-extension matching. */
const FILE_TYPE_EXTS: Record<string, readonly string[]> = {
  ts: ["ts", "tsx", "mts", "cts"],
  typescript: ["ts", "tsx", "mts", "cts"],
  js: ["js", "jsx", "mjs", "cjs", "vue"],
  javascript: ["js", "jsx", "mjs", "cjs", "vue"],
  py: ["py", "pyi"],
  python: ["py", "pyi"],
};

/** Extensions we never scan in the built-in fallback (binary / non-text). */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|bz2|7z|exe|dll|so|dylib|wasm|sqlite|db|bin|o|a|class|jar|mp[34]|mov|woff2?|ttf|eot|lock)$/i;

export const grepTool: ToolDefinition<GrepInput> = {
  name: "grep",
  description:
    "Search file contents by regex (ripgrep when available, otherwise a built-in scan). Supports ignoreCase, context lines (0-10 around each match), a glob filter, and a fileType filter (e.g. \"ts\"). Returns matching lines with file:line prefixes. Inside a git repo the built-in fallback searches tracked files plus untracked-but-not-ignored files (honoring .gitignore), matching ripgrep's default file set.",
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

export function ripgrepFileTypeArgs(fileType: string, knownTypes: ReadonlySet<string>): string[] {
  if (knownTypes.has(fileType)) return ["-t", fileType];
  const exts = FILE_TYPE_EXTS[fileType] ?? [fileType];
  return exts.flatMap((ext) => ["--glob", `*.${ext}`]);
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
    args.push(...ripgrepFileTypeArgs(fileType, known));
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
  // Cap DURING streaming, not after: a near-universal pattern (`.`/`e`/`import`)
  // over a large repo streams hundreds of MB of matches; buffering all of it into
  // one string before slicing to LIMIT spikes memory / OOMs. Stop at LIMIT+1 lines
  // and cancel rg (it dies on the broken pipe), so retained memory stays bounded.
  const { lines, truncated } = await readCappedLines(proc.stdout, LIMIT);
  if (truncated) {
    // We deliberately closed rg's pipe early; its (likely non-zero) exit is ours,
    // not a genuine search error — report the capped matches we collected.
    proc.kill();
    await proc.exited;
    return capResults(lines);
  }
  const code = await proc.exited;
  if (code === 1) return { output: "(no matches)" };
  if (code > 1) {
    const err = await new Response(proc.stderr).text();
    return { output: `ripgrep error: ${err}`, isError: true };
  }
  return capResults(lines);
}

/** Read newline-delimited lines from a stream up to `limit`, then STOP (cancel
 * the stream). Returns `truncated: true` once more than `limit` lines exist, so
 * the caller need not drain (and buffer) the rest. Shared shape with capResults:
 * a `truncated` batch carries `limit + 1` lines (capResults slices to `limit`
 * and appends the marker). Exported for a deterministic streaming-cap test. */
/** Max bytes retained for a single line while scanning (BUG-090). */
export const MAX_GREP_LINE_BYTES = 256_000;

export async function readCappedLines(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ lines: string[]; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buf = "";
  let truncated = false;
  try {
    while (!truncated) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Bound a single-line buffer so a multi-MB match line can't OOM (BUG-090).
      if (buf.length > MAX_GREP_LINE_BYTES) {
        lines.push(buf.slice(0, MAX_GREP_LINE_BYTES));
        truncated = true;
        break;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (lines.length > limit) {
          truncated = true;
          break;
        }
      }
    }
    if (!truncated) {
      buf += decoder.decode();
      if (buf) {
        if (buf.length > MAX_GREP_LINE_BYTES) {
          lines.push(buf.slice(0, MAX_GREP_LINE_BYTES));
          truncated = true;
        } else {
          lines.push(buf); // trailing line with no terminating newline
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { lines, truncated };
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
  let skippedLarge = 0;
  outer: for (const rel of files) {
    if (matchCount > LIMIT) break;
    if (ctx.abortSignal.aborted) break;
    const abs = join(ctx.cwd, rel);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) continue;
    if (info.size > MAX_FALLBACK_FILE_BYTES) {
      skippedLarge++;
      continue;
    }
    let text: string;
    try {
      text = await Bun.file(abs).text();
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
  const capped = capResults(results);
  if (!skippedLarge) return capped;
  const note = `…(skipped ${skippedLarge} file${skippedLarge === 1 ? "" : "s"} over ${Math.floor(MAX_FALLBACK_FILE_BYTES / 1024 / 1024)}MB in fallback grep)`;
  return {
    ...capped,
    output: capped.output === "(no matches)" ? `(no matches)\n${note}` : `${capped.output}\n${note}`,
  };
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
  // Prefer git's own file set so the fallback honors .gitignore (parity with
  // ripgrep, which respects .gitignore). Outside a git repo, walk the tree.
  const gitFiles = await gitCandidateFiles(cwd, root);
  const raw = gitFiles ?? (await walkFiles(cwd, root));
  return filterFiles(raw, glob, fileType);
}

/** git's default search set under `root`: tracked files (`--cached`) PLUS
 * untracked-but-not-ignored files (`--others --exclude-standard`) — exactly what
 * ripgrep searches by default. A prior version listed only tracked files, so the
 * fallback silently missed a just-written, not-yet-added file that rg would match
 * (the model would then conclude the symbol doesn't exist). Returns null when this
 * isn't a git repo / git is unavailable (→ caller walks the tree). */
async function gitCandidateFiles(cwd: string, root: string): Promise<string[] | null> {
  try {
    const sub = root === "." || root === "" ? "." : root;
    const proc = Bun.spawn(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", sub],
      { cwd, stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    // Exit 0 means we ARE in a git repo: return the set (possibly empty — an empty
    // result deliberately means "nothing to search here", NOT "walk").
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
  // A mapped fileType (ts/js/py/…) matches any of its ripgrep extensions; an
  // unmapped one keeps the literal `.<type>` behavior.
  const typeExts = fileType ? (FILE_TYPE_EXTS[fileType] ?? [fileType]) : null;
  const out: string[] = [];
  for (const f of files) {
    if (f.includes("node_modules/") || f === ".git" || f.startsWith(".git/")) continue;
    if (BINARY_EXT.test(f)) continue;
    if (typeExts && !typeExts.some((ext) => f.endsWith(`.${ext}`))) continue;
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
