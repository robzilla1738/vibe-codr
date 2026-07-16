/**
 * Fuzzy file ranking for the `@path` mention picker.
 *
 * Pure ranking over a provided path list (no fs) so unit tests stay hermetic.
 * The TUI loads candidate paths from cwd (capped) and feeds them here.
 */

/** Score a path against a query. Higher = better. 0 = no match. */
export function fuzzyPathScore(path: string, query: string): number {
  const p = path.replace(/\\/g, "/");
  const q = query.replace(/\\/g, "/").toLowerCase();
  if (!q) return 1; // empty query: every path is equally "ok"
  const lower = p.toLowerCase();
  const base = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;

  // Exact basename / full path.
  if (base === q) return 1000;
  if (lower === q) return 900;
  if (base.startsWith(q)) return 800 - Math.min(base.length - q.length, 50);
  if (lower.startsWith(q)) return 700 - Math.min(lower.length - q.length, 50);
  if (base.includes(q)) return 500 - Math.min(base.indexOf(q), 40);
  if (lower.includes(q)) return 300 - Math.min(lower.indexOf(q), 80);

  // Subsequence match on basename (fzy-style light).
  let bi = 0;
  let gaps = 0;
  let last = -1;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i]!;
    const found = base.indexOf(ch, bi);
    if (found < 0) return 0;
    if (last >= 0) gaps += found - last - 1;
    last = found;
    bi = found + 1;
  }
  return Math.max(1, 200 - gaps * 3 - (base.length - q.length));
}

/** Rank and cap paths for the picker. */
export function rankPaths(paths: readonly string[], query: string, max = 40): string[] {
  const scored = paths
    .map((path) => ({ path, score: fuzzyPathScore(path, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, max).map((x) => x.path);
}

/**
 * Detect a trailing `@path` mention in the draft (for autocomplete).
 * Returns the query after `@` and the absolute start index of that `@`,
 * or null when the draft is not mid-mention.
 *
 * Rules:
 *  - Only the last `@…` token (no spaces after `@` unless absolute path with spaces — we keep simple: no spaces)
 *  - Slash commands (`/…`) never open the file picker
 *  - Empty after `@` still opens (browse root)
 */
export function atMentionState(draft: string): { query: string; atIndex: number } | null {
  if (!draft || draft.startsWith("/")) return null;
  // Last `@` that begins a mention token: preceded by start or whitespace.
  const re = /(?:^|[\s])@([^\s@]*)$/;
  const m = re.exec(draft);
  if (!m) return null;
  const full = m[0]!;
  const atIndex = draft.length - full.length + (full.startsWith("@") ? 0 : 1);
  // Ensure the `@` we found is really at atIndex.
  if (draft[atIndex] !== "@") return null;
  return { query: m[1] ?? "", atIndex };
}

/** Replace the trailing `@query` with `@path` (space-terminated when run completes). */
export function applyAtMention(
  draft: string,
  atIndex: number,
  path: string,
  done: boolean,
): string {
  const prefix = draft.slice(0, atIndex);
  const mention = `@${path}${done ? " " : ""}`;
  return prefix + mention;
}

/**
 * List relative file paths under `root` for the picker (bounded, skip heavy dirs).
 * Synchronous readdir walk — only used when the `@` menu opens.
 */
export function listProjectFiles(
  root: string,
  opts: {
    maxFiles?: number;
    maxDepth?: number;
    readdir: (dir: string) => { name: string; isDirectory: boolean }[];
  },
): string[] {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxDepth = opts.maxDepth ?? 6;
  const skip = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".turbo",
    "coverage",
    ".next",
    ".cache",
    "target",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
  ]);
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries: { name: string; isDirectory: boolean }[];
    try {
      entries = opts.readdir(dir);
    } catch {
      return;
    }
    // Files first (name sort), then dirs — keeps shallow results useful.
    entries = [...entries].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      if (skip.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        walk(`${dir}/${e.name}`, childRel, depth + 1);
      } else {
        out.push(childRel);
      }
    }
  };
  walk(root, "", 0);
  return out;
}
