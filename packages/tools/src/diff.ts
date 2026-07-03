/**
 * Minimal line-level unified-diff generator. Kept dependency-free so the tools
 * package stays light; good enough to show the user what an edit/write changed.
 */

export interface DiffResult {
  /** Unified-diff-style text with ` `/`+`/`-` line prefixes, or "" if identical. */
  text: string;
  added: number;
  removed: number;
}

interface Op {
  kind: " " | "+" | "-";
  line: string;
}

/** Longest-common-subsequence line diff (Myers-equivalent for small inputs). */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as number[];
    const nextRow = lcs[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (nextRow[j + 1] as number) + 1
          : Math.max(nextRow[j] as number, row[j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] as string;
    const bj = b[j] as string;
    if (ai === bj) {
      ops.push({ kind: " ", line: ai });
      i++;
      j++;
    } else if ((lcs[i + 1] as number[])[j]! >= (lcs[i] as number[])[j + 1]!) {
      ops.push({ kind: "-", line: ai });
      i++;
    } else {
      ops.push({ kind: "+", line: bj });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", line: a[i++] as string });
  while (j < m) ops.push({ kind: "+", line: b[j++] as string });
  return ops;
}

/** Split into lines without a trailing empty element for a final newline. */
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Guard on the LCS matrix size (`(n+1)·(m+1)` numbers): editing or overwriting a
 * large file would otherwise allocate an O(n·m) matrix — a 20k-line file is
 * ~400M entries (multi-GB) and OOM-crashes the process. The cap depends only on
 * the two files' TOTAL line counts, not the edit size: a tiny edit to a ~6300+
 * line file (product > 40M) also takes the coarse fallback. Ordinary source
 * files diff fully; only large files fall back to the cheap coarse diff.
 */
const MAX_LCS_CELLS = 40_000_000;

/** A cheap O(n+m) line-multiset diff for files too large to LCS. Reports accurate
 * add/remove counts (lines present in one side but not the other) and a short
 * placeholder instead of the full text, so the file-changed event + `+a -b`
 * summary still work without the quadratic allocation. */
function coarseDiff(a: string[], b: string[]): DiffResult {
  const count = (arr: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const line of arr) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  let removed = 0;
  let added = 0;
  for (const [line, n] of ca) removed += Math.max(0, n - (cb.get(line) ?? 0));
  for (const [line, n] of cb) added += Math.max(0, n - (ca.get(line) ?? 0));
  return {
    text: `…(diff omitted: file too large to render — ${a.length} → ${b.length} lines)`,
    added,
    removed,
  };
}

/**
 * Build a compact unified diff between `before` and `after`. Unchanged runs are
 * collapsed to up to `context` lines around each change so large files stay
 * readable.
 */
export function unifiedDiff(
  before: string,
  after: string,
  context = 3,
): DiffResult {
  const a = toLines(before);
  const b = toLines(after);
  // Bail to a coarse diff before allocating a matrix that would OOM the process.
  if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) return coarseDiff(a, b);
  const ops = diffLines(a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "+") added++;
    else if (op.kind === "-") removed++;
  }
  if (added === 0 && removed === 0) return { text: "", added: 0, removed: 0 };

  // Mark which context lines to keep: any unchanged line within `context` of a
  // change. Everything else collapses to a single "…" elision marker.
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if ((ops[k] as Op).kind !== " ") {
      for (
        let d = Math.max(0, k - context);
        d <= Math.min(ops.length - 1, k + context);
        d++
      ) {
        keep[d] = true;
      }
    }
  }

  const out: string[] = [];
  let elided = false;
  for (let k = 0; k < ops.length; k++) {
    if (keep[k]) {
      const op = ops[k] as Op;
      // Unified-diff convention: prefix char then the line, no extra space.
      out.push(`${op.kind}${op.line}`);
      elided = false;
    } else if (!elided) {
      out.push("…");
      elided = true;
    }
  }
  return { text: out.join("\n"), added, removed };
}
