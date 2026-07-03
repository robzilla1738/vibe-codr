/**
 * The sidebar trail's pure core: one turn's reasoning stream + tool-activity
 * lines, appended INCREMENTALLY — only new bytes are ever split, never the
 * whole log (the per-token full-buffer re-split was a main-thread hot spot in
 * the freeze). Closed lines are trimmed; blank runs collapse to one "" spacer
 * (rendered as a paragraph break); `open` is the still-streaming line, shown
 * live and re-joined by the next chunk. Signal writes stay in app.tsx — this
 * holds only the line state, so it is directly unit-testable.
 */
export class Trail {
  #lines: string[] = [];
  #open = "";
  readonly #max: number;

  constructor(maxLines = 512) {
    this.#max = maxLines;
  }

  /** Close the streaming line: non-empty lands trimmed; blanks collapse. */
  #closeOpen(): void {
    const line = this.#open.trim();
    this.#open = "";
    if (line) this.#lines.push(line);
    else if (this.#lines.length > 0 && this.#lines[this.#lines.length - 1] !== "") this.#lines.push("");
  }

  #cap(): void {
    if (this.#lines.length > this.#max) this.#lines.splice(0, this.#lines.length - this.#max);
  }

  /** Append raw reasoning bytes — splits ONLY this chunk. */
  append(chunk: string): void {
    const segs = chunk.split("\n");
    this.#open += segs[0] ?? "";
    for (let i = 1; i < segs.length; i++) {
      this.#closeOpen();
      this.#open = segs[i] ?? "";
    }
    this.#cap();
  }

  /** Record a whole line of its own (a tool-activity label). */
  pushLine(line: string): void {
    this.#closeOpen();
    this.#lines.push(line);
    this.#cap();
  }

  /** The rendered lines: closed + the open one, no trailing spacer. */
  snapshot(): string[] {
    const open = this.#open.trim();
    const out = open ? [...this.#lines, open] : this.#lines.slice();
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out.slice(-this.#max);
  }

  reset(): void {
    this.#lines = [];
    this.#open = "";
  }
}

/**
 * The transcript render window: index of the first turn kept in the layout
 * tree. Everything older folds behind the "▸ N earlier turns" row — windowing
 * is what bounds per-commit relayout cost (yoga measures every child in the
 * tree, so an unbounded transcript froze the shared engine+UI thread).
 */
export function windowStartIndex(totalTurns: number, windowTurns: number, revealed: number): number {
  return Math.max(0, totalTurns - windowTurns - revealed);
}
