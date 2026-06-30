import { z } from "zod";
import { Glob } from "bun";
import { extname, join } from "node:path";
import type { ToolDefinition } from "@vibe/shared";

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
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".kt", ".rb", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".scala",
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

/** Rank files so the most orienting ones (entrypoints, shallow paths) come first. */
export function rankFiles(files: string[]): string[] {
  const score = (f: string): number => {
    const depth = f.split("/").length;
    const base = f.split("/").pop() ?? f;
    let s = depth; // shallower is better (lower score sorts first)
    if (/^(index|main|mod|lib|app)\./.test(base)) s -= 5; // entrypoints first
    if (/\.(test|spec)\./.test(base)) s += 5; // tests last
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
  const files: string[] = [];
  const glob = new Glob(`${sub ? `${sub.replace(/\/$/, "")}/` : ""}**/*`);
  try {
    for await (const f of glob.scan({ cwd, onlyFiles: true })) {
      if (f.includes("node_modules/") || f.startsWith(".git/")) continue;
      if (isCodeFile(f)) files.push(f);
      if (files.length >= 5_000) break; // bound the scan
    }
  } catch {
    /* unreadable dir — return what we have */
  }
  return files;
}

export const repoMapTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "repo_map",
  description:
    "Get a structural map of the codebase — a ranked list of source files with their top-level declarations (exports, functions, classes, types). Use this FIRST to orient on an unfamiliar repo or subsystem before blind glob/grep: it shows where things live in one cheap call. Narrow with `path` for a focused subtree.",
  inputSchema: Input,
  readOnly: true,
  concurrencySafe: true,
  async execute({ path, maxFiles }, ctx) {
    const all = await listFiles(ctx.cwd, path);
    if (!all.length) {
      return { output: `No tracked source files found${path ? ` under ${path}` : ""}.` };
    }
    const ranked = rankFiles(all);
    const limit = maxFiles ?? DEFAULT_MAX_FILES;
    const considered = ranked.slice(0, limit);
    let budget = CHAR_BUDGET;
    const blocks: string[] = [];
    for (const file of considered) {
      if (budget <= 0) break;
      const content = await Bun.file(join(ctx.cwd, file)).text().catch(() => "");
      if (!content) continue;
      const symbols = extractSymbols(content, extname(file));
      if (!symbols.length) continue;
      const block = `${file}\n${symbols.map((s) => `  ${s}`).join("\n")}`;
      budget -= block.length;
      blocks.push(block);
    }
    if (!blocks.length) {
      return { output: `Mapped ${all.length} file(s) but found no top-level declarations.` };
    }
    const omitted = all.length - considered.length;
    const note =
      omitted > 0
        ? `\n\n…(${omitted} more file(s) not shown; pass a \`path\` to focus or raise \`maxFiles\`)`
        : "";
    return {
      output: `Repository map — ${blocks.length} file(s) with declarations${path ? ` under ${path}` : ""}:\n\n${blocks.join("\n\n")}${note}`,
    };
  },
};
