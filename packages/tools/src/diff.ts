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
 * Build a compact unified diff between `before` and `after`. Unchanged runs are
 * collapsed to up to `context` lines around each change so large files stay
 * readable.
 */
export function unifiedDiff(
  before: string,
  after: string,
  context = 3,
): DiffResult {
  const ops = diffLines(toLines(before), toLines(after));
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
