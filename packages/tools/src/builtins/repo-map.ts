import { z } from "zod";
import { Glob } from "bun";
import { statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { resolveContainedDir } from "./glob.ts";
import type { ToolDefinition } from "@vibe/shared";
import { readTextIfExists } from "../fs/safe-read.ts";

const Input = z.object({
  path: z
    .string()
    .optional()
    .describe("Limit the map to files under this directory (relative to cwd)."),
  maxFiles: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap on the number of files mapped (default 150)."),
});

const DEFAULT_MAX_FILES = 150;
/** Total char budget for the rendered map, so it never floods the context. */
const CHAR_BUDGET = 20_000;
/** Per-file symbol cap. */
const MAX_SYMBOLS_PER_FILE = 50;

/** Source extensions worth mapping (declaration-bearing languages). */
const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".scala",
]);

export function isCodeFile(path: string): boolean {
  return CODE_EXT.has(extname(path).toLowerCase());
}

/** Top-level declaration matchers per language family. */
function declarationPattern(ext: string): RegExp | undefined {
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return /^(export\b|(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace|abstract)\b)/;
    case ".py":
      return /^(?:async\s+)?def\s+\w|^class\s+\w/;
    case ".go":
      return /^func\s|^type\s+\w/;
    case ".rs":
      return /^(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|type|mod|macro_rules!)\b/;
    case ".rb":
      return /^(?:def|class|module)\s+\w/;
    case ".java":
    case ".kt":
    case ".scala":
    case ".cs":
    case ".swift":
      return /\b(?:class|interface|enum|struct|object|trait|fun|func|void|public|private|protected|internal)\b.*\w/;
    default:
      return /^(?:export\b|function|class|struct|def|fn|type)\b/;
  }
}

/**
 * Extract a file's top-level declaration lines (a cheap symbol map without a
 * parser): exported members + top-level functions/classes/types. Nested members
 * (indented > 2 cols) are skipped so the map stays high-signal.
 */
export function extractSymbols(content: string, ext: string): string[] {
  const re = declarationPattern(ext.toLowerCase());
  if (!re) return [];
  const out: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const indent = line.length - line.trimStart().length;
    if (indent > 2) continue; // skip nested members — keep the top-level shape
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (re.test(trimmed)) {
      // Drop a trailing block-opening brace (`{` or an empty `{}`) for a cleaner
      // signature; lines without a brace (e.g. `type X = string;`) are unchanged.
      out.push(trimmed.replace(/\s*\{\s*\}?\s*$/, "").slice(0, 140));
      if (out.length >= MAX_SYMBOLS_PER_FILE) break;
    }
  }
  return out;
}

/**
 * Relative import specifiers a file declares (JS/TS `from "./x"` / `require` /
 * dynamic `import()`, Python `from .x import`). Package imports are ignored —
 * only intra-repo edges feed the reference graph.
 */
export function parseImports(content: string, ext: string): string[] {
  const e = ext.toLowerCase();
  const specs: string[] = [];
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(e)) {
    for (const m of content.matchAll(
      /(?:from\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g,
    )) {
      if (m[1]) specs.push(m[1]);
    }
  } else if (e === ".py") {
    for (const m of content.matchAll(/^from\s+(\.[\w.]*)\s+import\b/gm)) {
      if (m[1]) specs.push(m[1]);
    }
  }
  return specs;
}

/** Resolve a relative JS/TS import spec against the importing file to a repo
 * file present in `known` (tries the spec, +extensions, /index variants). */
function resolveImport(fromFile: string, spec: string, known: Set<string>): string | undefined {
  const base = normalize(join(dirname(fromFile), spec)).replaceAll("\\", "/");
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((ext) => `${base}${ext}`),
    ...["/index.ts", "/index.tsx", "/index.js"].map((ix) => `${base}${ix}`),
    // `./x.ts` written with its extension already, or `./x.js` referring to x.ts
    base.replace(/\.js$/, ".ts"),
  ];
  return candidates.find((c) => known.has(c));
}

/**
 * Rank files so the most orienting ones come first: import in-degree (how many
 * repo files reference this one — the strongest "this is load-bearing" signal),
 * fused with the entrypoint-name and shallow-path heuristics; tests last.
 * `inDegree` is optional so the pure heuristic ranking still works alone.
 */
export function rankFiles(files: string[], inDegree?: Map<string, number>): string[] {
  const score = (f: string): number => {
    const depth = f.split("/").length;
    const base = f.split("/").pop() ?? f;
    let s = depth; // shallower is better (lower score sorts first)
    if (/^(index|main|mod|lib|app)\./.test(base)) s -= 5; // entrypoints first
    if (/\.(test|spec)\./.test(base)) s += 25; // tests last, even when imported
    const refs = inDegree?.get(f) ?? 0;
    if (refs > 0) s -= Math.min(6, 1 + Math.log2(refs) * 2); // referenced = load-bearing
    return s;
  };
  return [...files].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

/** Tracked code files via `git ls-files`, falling back to a glob outside git. */
async function listFiles(cwd: string, sub: string | undefined): Promise<string[]> {
  try {
    const proc = Bun.spawn(["git", "ls-files", "-z", sub ?? "."], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0 && out) {
      return out.split("\0").filter(Boolean).filter(isCodeFile);
    }
  } catch {
    /* not a git repo (or git missing) — fall through to glob */
  }
  // BUG-055: contain `sub` under cwd — never walk `../sibling` via relative globs.
  let scanCwd = cwd;
  if (sub) {
    const resolved = resolveContainedDir(cwd, sub);
    if (typeof resolved === "object") return [];
    scanCwd = resolved;
  }
  const files: string[] = [];
  const glob = new Glob("**/*");
  try {
    for await (const f of glob.scan({ cwd: scanCwd, onlyFiles: true })) {
      if (f.includes("node_modules/") || f.startsWith(".git/") || f.includes("/.git/")) continue;
      // Re-prefix relative to the original session cwd when we scanned a subdir.
      const rel = sub ? `${sub.replace(/\/$/, "")}/${f}` : f;
      if (isCodeFile(rel)) files.push(rel);
      if (files.length >= 5_000) break; // bound the scan
    }
  } catch {
    /* unreadable dir — return what we have */
  }
  return files;
}

interface FileEntry {
  mtimeMs: number;
  symbols: string[];
  imports: string[];
}

/** Per-workspace incremental cache: only files whose mtime changed are re-read
 * on subsequent calls (the tool used to re-read up to 150 files every call). */
const mapCache = new Map<string, Map<string, FileEntry>>();

/** Skip symbol-extracting a single file larger than this (bytes). A tracked but
 * generated/bundled/fixture file (a committed multi-MB `.pb.ts` or bundle) would
 * otherwise be slurped whole into memory on every non-cached build — and several
 * such reads can be in flight when a gate refresh overlaps a subagent's build. */
const MAX_FILE_BYTES = 512 * 1024;

/** Test hook: drop the incremental cache so tests can't leak state. */
export function _resetRepoMapCache(): void {
  mapCache.clear();
}

export interface RepoMapResult {
  /** Rendered `path\n  symbol` blocks, budget-bounded. */
  text: string;
  /** How many files carry declarations (before the budget cut). */
  fileCount: number;
  truncated: boolean;
}

/**
 * Build a ranked, token/char-budgeted symbol map of the workspace. Shared by
 * the `repo_map` tool and the engine's subagent-kickoff injection, so both see
 * the same map. Incremental: unchanged files (by mtime) are served from cache.
 */
export async function buildRepoMap(
  cwd: string,
  opts: { path?: string; maxFiles?: number; charBudget?: number; readLimit?: number } = {},
): Promise<RepoMapResult> {
  const all = await listFiles(cwd, opts.path);
  if (!all.length) return { text: "", fileCount: 0, truncated: false };

  const cacheKey = cwd;
  let cache = mapCache.get(cacheKey);
  if (!cache) {
    cache = new Map();
    mapCache.set(cacheKey, cache);
  }

  // Bound the number of files we actually READ+parse, not just the count we
  // rank/render. The git path lists EVERY tracked code file; reading all of them
  // to build the import graph stalls bootstrap on a large monorepo (30k files)
  // and re-pays that cost every fresh CLI run. Pre-rank by the cheap path
  // heuristic and parse only the top slice — the in-degree refinement below then
  // reorders within it. `known` still spans every file so imports resolve to
  // files we didn't parse.
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const readLimit = opts.readLimit ?? Math.max(maxFiles * 4, 400);
  const toRead = all.length > readLimit ? rankFiles(all).slice(0, readLimit) : all;

  const known = new Set(all);
  const entries = new Map<string, FileEntry>();
  for (const file of toRead) {
    const full = join(cwd, file);
    let mtimeMs = 0;
    let sizeBytes = 0;
    try {
      const st = statSync(full);
      mtimeMs = st.mtimeMs;
      sizeBytes = st.size;
    } catch {
      continue; // listed but unreadable — skip
    }
    // Don't slurp a huge generated/bundled file just to regex it for symbols.
    if (sizeBytes > MAX_FILE_BYTES) continue;
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) {
      entries.set(file, cached);
      continue;
    }
    const content = await readTextIfExists(full).catch(() => null);
    if (content === null) continue;
    const ext = extname(file);
    const entry: FileEntry = {
      mtimeMs,
      symbols: extractSymbols(content, ext),
      imports: parseImports(content, ext),
    };
    cache.set(file, entry);
    entries.set(file, entry);
  }
  // Drop cache entries for files that no longer exist (keeps the cache honest).
  for (const key of cache.keys()) {
    if (!known.has(key)) cache.delete(key);
  }

  // Reference graph: count how many files import each file.
  const inDegree = new Map<string, number>();
  for (const [file, entry] of entries) {
    for (const spec of entry.imports) {
      const target = resolveImport(file, spec, known);
      if (target && target !== file) inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }

  const ranked = rankFiles([...entries.keys()], inDegree).slice(0, maxFiles);
  let budget = opts.charBudget ?? CHAR_BUDGET;
  const blocks: string[] = [];
  let withSymbols = 0;
  let truncated = false;
  for (const file of ranked) {
    const symbols = entries.get(file)?.symbols ?? [];
    if (!symbols.length) continue;
    withSymbols++;
    const block = `${file}\n${symbols.map((s) => `  ${s}`).join("\n")}`;
    if (budget - block.length < 0) {
      truncated = true;
      break;
    }
    budget -= block.length;
    blocks.push(block);
  }
  return {
    text: blocks.join("\n\n"),
    fileCount: withSymbols,
    truncated: truncated || ranked.length < entries.size || toRead.length < all.length,
  };
}

export const repoMapTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "repo_map",
  description:
    "Get a structural map of the codebase — a ranked list of source files with their top-level declarations (exports, functions, classes, types), ordered by how load-bearing each file is (import references + entrypoints). Use this FIRST to orient on an unfamiliar repo or subsystem before blind glob/grep: it shows where things live in one cheap call. Narrow with `path` for a focused subtree.",
  inputSchema: Input,
  readOnly: true,
  concurrencySafe: true,
  async execute({ path, maxFiles }, ctx) {
    const result = await buildRepoMap(ctx.cwd, {
      ...(path ? { path } : {}),
      ...(maxFiles ? { maxFiles } : {}),
    });
    if (!result.text) {
      const all = await listFiles(ctx.cwd, path);
      return {
        output: all.length
          ? `Mapped ${all.length} file(s) but found no top-level declarations.`
          : `No tracked source files found${path ? ` under ${path}` : ""}.`,
      };
    }
    const note = result.truncated
      ? `\n\n…(more files not shown; pass a \`path\` to focus or raise \`maxFiles\`)`
      : "";
    return {
      output: `Repository map — ${result.fileCount} file(s) with declarations${path ? ` under ${path}` : ""}:\n\n${result.text}${note}`,
    };
  },
};
