/**
 * The sidebar Thinking trail's pure core: one turn's **reasoning** stream,
 * appended INCREMENTALLY — only new bytes are ever split, never the whole log
 * (the per-token full-buffer re-split was a main-thread hot spot in the freeze).
 * Tool activity lives only in the chat transcript (ToolBlockView), so this
 * never mixes `toolLabel` lines — that dual channel was redundant clutter.
 *
 * Closed lines are trimmed; blank runs collapse to one "" spacer (rendered as
 * a paragraph break); `open` is the still-streaming line, shown live and
 * re-joined by the next chunk. Signal writes stay in app.tsx — this holds only
 * the line state, so it is directly unit-testable.
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

  /** Hard cap on the still-streaming open line (newline-free floods). */
  static readonly MAX_OPEN_CHARS = 16_384;

  /** Append raw reasoning bytes — splits ONLY this chunk. */
  append(chunk: string): void {
    const segs = chunk.split("\n");
    this.#open += segs[0] ?? "";
    if (this.#open.length > Trail.MAX_OPEN_CHARS) {
      this.#open = this.#open.slice(-Trail.MAX_OPEN_CHARS);
    }
    for (let i = 1; i < segs.length; i++) {
      this.#closeOpen();
      this.#open = segs[i] ?? "";
      if (this.#open.length > Trail.MAX_OPEN_CHARS) {
        this.#open = this.#open.slice(-Trail.MAX_OPEN_CHARS);
      }
    }
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

/**
 * In-turn render window: the index of the first ITEM kept in a single turn's
 * layout. Turn-level windowing bounds relayout across turns, but ONE turn with
 * hundreds of tool blocks (a scaffold generator, a long yolo run) still grows the
 * yoga tree without bound — the same freeze class. This caps a turn's rendered
 * items to `maxItems`, but only advances the start in whole `step` increments so
 * the `<Index>` list reshuffles at most once every `step` appends (a per-append
 * slice would re-key every row on the hot streaming path). Returns 0 until the
 * item count exceeds the cap.
 */
export function turnWindowStart(
  totalItems: number,
  maxItems: number,
  step: number,
  revealed = 0,
): number {
  const targetVisible = maxItems + Math.max(0, revealed);
  if (totalItems <= targetVisible) return 0;
  // Smallest multiple of `step` that keeps the visible count (total - start) at
  // or under `targetVisible` — so the start only moves in whole `step` jumps.
  return Math.ceil((totalItems - targetVisible) / step) * step;
}
