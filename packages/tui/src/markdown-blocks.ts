/**
 * Split a markdown reply into top-level blocks — prose, headings, blockquotes,
 * fenced code, GFM tables — and render tables to clean box-drawing lines.
 *
 * Why: OpenTUI's `<markdown>` renderable has a layout bug where a code/table block
 * blanks its *sibling* prose (even across separate `<markdown>` instances). Since
 * coding replies constantly mix prose with code, that silently ate the prose. So
 * the TUI renders prose via `<markdown>` (which is reliable in isolation, keeping
 * inline bold/italic/code conceal) and renders headings, quotes, code + tables
 * itself from `<box>`/`<text>` primitives — which also lets us style each element
 * type explicitly (heading/table-header in the accent, quotes with a gutter, code
 * in its own tone). This module is the pure (testable, no-OpenTUI) core.
 */

export type Align = "left" | "right" | "center";

export type MdBlock =
  | { kind: "prose"; text: string }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "table"; rows: string[][]; align: Align[] }
  /** An ATX heading (`#`..`######`); `level` is 1..6. */
  | { kind: "heading"; level: number; text: string }
  /** A `>` blockquote; `lines` are the quoted lines with the marker stripped. */
  | { kind: "quote"; lines: string[] };

/**
 * A rendered table line. A `rule` is a ready-made box-drawing divider (top, header,
 * inter-row, or bottom) the UI draws in the border tone. A `header`/`row` carries
 * its columns as separate `cells` (each pre-padded to its column width) so the UI
 * draws the `│` borders in the border tone and the cells in their role color — a
 * proper grid like opencode's. The `┬┼┴` junctions in the rules line up under the
 * `│` separators because every ` cell ` and every rule segment is `width+2` wide.
 */
export type TableLine =
  | { role: "rule"; text: string }
  | { role: "header" | "row"; cells: string[] };

/** Terminal columns one code point occupies: 0 for combining/zero-width marks, 2
 * for East-Asian wide + fullwidth + emoji, else 1. A compact wcwidth — enough to
 * keep table columns aligned when a cell holds CJK/emoji (which count as one code
 * point but render two cells), without pulling in a dependency. */
function charWidth(cp: number): number {
  if (cp === 0) return 0;
  // Combining marks, zero-width spaces/joiners, variation selectors.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff
  )
    return 0;
  // Wide: CJK, Hangul, Kana, fullwidth forms, and the emoji/symbol planes.
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Kana … CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) || // emoji, symbols, tiles
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  )
    return 2;
  return 1;
}

/** Grapheme segmenter for cluster-aware width (ZWJ emoji, flags, VS16). */
const GRAPHEMES =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/** Width of ONE grapheme cluster: an emoji-presentation (VS16) or ZWJ sequence
 * renders as a single 2-cell glyph; otherwise the widest codepoint wins (so a
 * flag's two regional indicators count 2 once, not 4). */
function graphemeWidth(g: string): number {
  if (/[\u200d\ufe0f]/u.test(g)) return 2; // ZWJ sequence / emoji presentation
  let w = 0;
  for (const ch of g) w = Math.max(w, charWidth(ch.codePointAt(0)!));
  return w;
}

/** Display width of a string in terminal cells. Sums {@link charWidth} per code
 * point on the fast path; strings that can contain multi-codepoint clusters
 * (ZWJ sequences `👨‍👩‍👧`, flags `🇺🇸`, VS16 emoji `☀️`) are measured per GRAPHEME —
 * per-codepoint summing over/under-counts those and drifts table columns. */
export function displayWidth(s: string): number {
  let w = 0;
  if (GRAPHEMES && /[\u200d\ufe0f\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}]/u.test(s)) {
    for (const { segment } of GRAPHEMES.segment(s)) w += graphemeWidth(segment);
    return w;
  }
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Detects strings whose width needs GRAPHEME measurement (matches
 * {@link displayWidth}'s slow-path trigger): ZWJ sequences, VS16 emoji
 * presentation (a NARROW base like ❤/☀ + U+FE0F renders 2 cells —
 * per-codepoint summing undercounts it), flags, skin tones. */
const CLUSTER_RE = /[\u200d\ufe0f\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}]/u;

/** Truncate `s` to at most `n` display cells, appending `…` when it was cut.
 * Fast path iterates CODE POINTS (a surrogate pair is never split — no stranded
 * half) and measures terminal cells, so CJK/emoji clip AT the column edge
 * instead of past it; cluster-bearing strings (VS16/ZWJ/flags) walk GRAPHEMES so
 * a 2-cell VS16 emoji can't be counted as 1 and blow the budget. Linear either way. */
export function truncateWidth(s: string, n: number): string {
  if (n <= 0) return "";
  if (displayWidth(s) <= n) return s;
  const keep = n - 1; // reserve one cell for the ellipsis
  let out = "";
  let w = 0;
  if (GRAPHEMES && CLUSTER_RE.test(s)) {
    for (const { segment } of GRAPHEMES.segment(s)) {
      const cw = graphemeWidth(segment);
      if (w + cw > keep) break;
      out += segment;
      w += cw;
    }
    return `${out}…`; // cluster boundaries — nothing dangling to strip
  }
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > keep) break;
    out += ch;
    w += cw;
  }
  // A cut mid-ZWJ-sequence must not leave a dangling joiner gluing the `…` into
  // the previous emoji.
  return `${out.replace(/[\u200d\ufe0f]+$/u, "")}…`;
}

/** Keep the TRAILING `n` display cells of `s`, prefixing `…` when it was cut —
 * for deep paths, where the trailing segments are the ones that identify where
 * you are. Same fast/cluster split as {@link truncateWidth} (surrogate-safe). */
export function tailWidth(s: string, n: number): string {
  if (n <= 0) return "";
  if (displayWidth(s) <= n) return s;
  const keep = n - 1; // reserve one cell for the ellipsis
  let out = "";
  let w = 0;
  if (GRAPHEMES && CLUSTER_RE.test(s)) {
    const segs = [...GRAPHEMES.segment(s)].map((g) => g.segment);
    for (let i = segs.length - 1; i >= 0; i--) {
      const cw = graphemeWidth(segs[i]!);
      if (w + cw > keep) break;
      out = segs[i]! + out;
      w += cw;
    }
    return `…${out}`; // cluster boundaries — nothing dangling to strip
  }
  const chars = [...s];
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i]!.codePointAt(0)!);
    if (w + cw > keep) break;
    out = chars[i]! + out;
    w += cw;
  }
  // The cut must not open on a bare joiner/combining mark that would stack onto
  // the `…`.
  return `…${out.replace(/^[\u200d\ufe0f\u0300-\u036f]+/u, "")}`;
}

/**
 * Strip inline markdown (emphasis / code / links) for text we render OURSELVES —
 * table cells, headings, blockquotes. OpenTUI's native `<markdown>` conceals these
 * for prose, but our hand-rendered `<text>` primitives would otherwise show the raw
 * `**` / `*` / `` ` `` / `~~` / `[label](url)` markers. Bold is stripped before
 * italic so `**x**` doesn't leave a stray `*`.
 */
export function stripInline(s: string): string {
  return (
    s
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image ![alt](url) → alt
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link [text](url) → text
      .replace(/\*\*(.+?)\*\*/g, "$1") // bold **
      // `_`-emphasis must be flanked by non-word chars, or an identifier like
      // `max_retry_count` / `get_user_by_id` in a table cell/heading/blockquote gets
      // its underscores eaten (→ `maxretrycount`).
      .replace(/(?<![\p{L}\p{N}_])__(.+?)__(?![\p{L}\p{N}_])/gu, "$1") // bold __
      // Italic `*` needs CommonMark's flanking rule (content starts AND ends on a
      // non-space) or literal asterisk pairs get eaten: `*.ts and *.js` (globs) and
      // `2 * 3 and 4 * 5` (math) must survive — only real `*emphasis*` is stripped.
      // The body is `[^*]`-bounded (never `.*?`, which backtracks O(n²) on `*`-dense
      // text and froze the TUI render thread ~1.8s on a 96KB line — this pass re-runs
      // per streamed markdown chunk): `[^*]*` can't scan past the next `*`, so it's
      // linear, and it still honors flanking (leading/trailing char is `\S`).
      .replace(/\*(\S[^*]*\S|\S)\*/g, "$1") // italic *
      .replace(/(?<![\p{L}\p{N}_])_(.+?)_(?![\p{L}\p{N}_])/gu, "$1") // italic _
      .replace(/~~(.+?)~~/g, "$1") // strikethrough
      .replace(/`([^`]+)`/g, "$1") // inline code
      .trim()
  );
}

/** A GFM delimiter row: `| --- | :--: |` (only `|`, `-`, `:`, spaces; has a `-`). */
function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  return t.includes("-") && /^\|?[\s:|-]+\|?$/.test(t) && t.replace(/[^|]/g, "").length >= 1;
}

/** Split a `| a | b |` row into trimmed cells (drops the optional outer pipes).
 * A GFM escaped pipe (`\|`) is a literal `|` INSIDE a cell, not a column break. A
 * pipe delimits only when preceded by an EVEN run of backslashes (so `\|` is an
 * escaped pipe but `\\|` is an escaped backslash followed by a real delimiter) —
 * a fixed-width lookbehind can't tell those apart, so we count the run. */
function parseRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  const cells: string[] = [];
  let cur = "";
  let backslashes = 0; // consecutive backslashes immediately before the cursor
  for (const ch of t) {
    if (ch === "|" && backslashes % 2 === 0) {
      cells.push(cur);
      cur = "";
      backslashes = 0;
      continue;
    }
    cur += ch;
    backslashes = ch === "\\" ? backslashes + 1 : 0;
  }
  cells.push(cur);
  // Drop the trailing empty cell produced by an optional closing outer pipe.
  if (cells.length > 1 && cells[cells.length - 1]!.trim() === "") cells.pop();
  // Unescape GFM sequences: `\|` → `|` and `\\` → `\`.
  return cells.map((c) => c.replace(/\\([\\|])/g, "$1").trim());
}

function parseAlign(delim: string): Align[] {
  return parseRow(delim).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : "left";
  });
}

/**
 * Split markdown into prose / code / table blocks. Tolerant of *incomplete*
 * blocks (streaming): an unterminated ``` fence keeps everything after it as code
 * in-progress; a table without its delimiter row yet stays prose until it arrives.
 */
export function splitMarkdown(src: string): MdBlock[] {
  return splitMarkdownIndexed(src).blocks;
}

/** Like `splitMarkdown` but also returns, per block, the SOURCE LINE INDEX where
 * that block began. The line indices power `createMarkdownSplitter`'s incremental
 * re-parse: for append-only input, everything before the last block's start is
 * immutable, so only the tail needs re-splitting. */
export function splitMarkdownIndexed(src: string): { blocks: MdBlock[]; startLines: number[] } {
  const lines = src.split("\n");
  const blocks: MdBlock[] = [];
  const startLines: number[] = [];
  let prose: string[] = [];
  let proseStart = -1;
  const flushProse = () => {
    const text = prose.join("\n").replace(/^\n+|\n+$/g, "");
    if (text.trim()) {
      blocks.push({ kind: "prose", text });
      startLines.push(proseStart);
    }
    prose = [];
    proseStart = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      flushProse();
      const start = i;
      const marker = fence[2]!;
      const lang = (fence[3] ?? "").trim();
      const code: string[] = [];
      const close = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
      i++;
      while (i < lines.length && !close.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i++;
      }
      // i now sits on the closing fence (or past EOF for a streaming-open block).
      blocks.push({ kind: "code", lang, lines: code });
      startLines.push(start);
      continue;
    }
    // An ATX heading — `#`..`######` + at least one space + text. A lone `#` (no
    // space yet, mid-stream) stays prose until its text arrives. Headings inside a
    // fence never reach here (the code branch consumed them above).
    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (heading) {
      flushProse();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: stripInline(heading[2]!) });
      startLines.push(i);
      continue;
    }
    // A `>` blockquote — gather consecutive quoted lines, stripping the marker.
    // ALL leading `>` levels are stripped (a nested `> > deep` flattens rather
    // than showing the inner marker literally — depth doesn't survive terminal
    // scale anyway).
    if (/^\s*>/.test(line)) {
      flushProse();
      const start = i;
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) {
        quoted.push(stripInline((lines[i] ?? "").replace(/^\s*(?:>[ \t]?)+/, "")));
        i++;
      }
      i--; // step back so the for-loop's ++ lands on the first non-quote line
      blocks.push({ kind: "quote", lines: quoted });
      startLines.push(start);
      continue;
    }
    if (line.includes("|") && isDelimiterRow(lines[i + 1] ?? "")) {
      flushProse();
      const start = i;
      const rows: string[][] = [parseRow(line)];
      const align = parseAlign(lines[i + 1] ?? "");
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        rows.push(parseRow(lines[i] ?? ""));
        i++;
      }
      i--; // step back so the for-loop's ++ lands on the first non-table line
      blocks.push({ kind: "table", rows, align });
      startLines.push(start);
      continue;
    }
    if (proseStart < 0) proseStart = i;
    prose.push(line);
  }
  flushProse();
  return { blocks, startLines };
}

/**
 * A stateful splitter that re-parses ONLY the changed tail for append-only input.
 * `AssistantText` re-splits the whole accumulated reply on every frame during
 * streaming — O(n) per frame, O(n²) over the turn. The parser is a forward line
 * scan with ≤1 line of lookahead and no cross-block state, so for append-only
 * input every block strictly before the last is immutable; re-parsing from the
 * last block's start line is byte-identical to a full parse. Any non-append input
 * (a shrink, an edit) falls back to a full re-split. One splitter per component
 * instance (each AssistantText caches its own stream).
 */
export function createMarkdownSplitter(): (src: string) => MdBlock[] {
  let prevSrc = "";
  let prevBlocks: MdBlock[] = [];
  let prevStartLines: number[] = [];
  return (src) => {
    if (src === prevSrc) return prevBlocks;
    if (prevBlocks.length > 0 && src.startsWith(prevSrc)) {
      const from = prevStartLines[prevStartLines.length - 1]!;
      const suffix = src.split("\n").slice(from).join("\n");
      const tail = splitMarkdownIndexed(suffix);
      const blocks = [...prevBlocks.slice(0, -1), ...tail.blocks];
      const startLines = [...prevStartLines.slice(0, -1), ...tail.startLines.map((s) => s + from)];
      prevSrc = src;
      prevBlocks = blocks;
      prevStartLines = startLines;
      return blocks;
    }
    const fresh = splitMarkdownIndexed(src);
    prevSrc = src;
    prevBlocks = fresh.blocks;
    prevStartLines = fresh.startLines;
    return fresh.blocks;
  };
}

/** Take the leading `w` display columns of `s`, returning `[head, rest]`. Never
 * splits a wide glyph across the boundary, and always advances by ≥1 char so a
 * wide glyph in a 1-wide column can't loop forever. */
function sliceByWidth(s: string, w: number): [string, string] {
  const chars = [...s];
  let width = 0;
  let i = 0;
  for (; i < chars.length; i++) {
    const cw = charWidth(chars[i]!.codePointAt(0)!);
    if (width + cw > w) break;
    width += cw;
  }
  if (i === 0 && chars.length > 0) i = 1; // guarantee progress
  return [chars.slice(0, i).join(""), chars.slice(i).join("")];
}

/** Greedy word-wrap `s` to `width` display columns; a word longer than `width` is
 * hard-broken. A cell that already fits is returned verbatim (preserving any
 * intentional internal spacing — re-flow only runs on genuine overflow). Widths
 * are measured in terminal cells so CJK/emoji wrap correctly. Always returns at
 * least one (possibly empty) line. A cell that reads as a LIST ITEM (`• x` /
 * `- x` / `1. x`) hangs its continuation lines under the item TEXT, not the
 * marker — a wrapped bullet stays one visual item instead of the overflow
 * snapping back flush-left under the `•`. */
function wrapCell(s: string, width: number): string[] {
  const w = Math.max(1, width);
  if (displayWidth(s) <= w) return [s];
  // List-item hanging indent: wrap the text after the marker into a narrower
  // budget, then re-indent the continuations. Skipped when the column is too
  // tight for the indent to leave legible text (≥3 cells).
  const marker = /^([-•*·]|\d{1,3}[.)])\s+/.exec(s);
  if (marker && w - marker[0].length >= 3) {
    const indent = " ".repeat(marker[0].length);
    const rest = wrapCell(s.slice(marker[0].length), w - marker[0].length);
    return rest.map((line, i) => (i === 0 ? marker[0] + line : indent + line));
  }
  const lines: string[] = [];
  let cur = "";
  for (let word of s.split(/\s+/).filter(Boolean)) {
    // Hard-break a single word that can't fit the column (by display width).
    while (displayWidth(word) > w) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      const [head, rest] = sliceByWidth(word, w);
      lines.push(head);
      word = rest;
    }
    if (!word) continue;
    if (!cur) cur = word;
    else if (displayWidth(cur) + 1 + displayWidth(word) <= w) cur += ` ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur || lines.length === 0) lines.push(cur);
  return lines;
}

/** Per-column chrome: a left `│` + one padding cell each side of the content
 * (` cell `). Plus one trailing `│` for the whole grid. */
const COL_CHROME = 3;

/**
 * Whether a grid with `cols` columns can physically fit in `maxWidth`: the
 * shrink loop in {@link renderTable} floors content at 3 cells per column, so
 * the minimum grid is `(3 chrome + 3 content) × cols + 1`. Beyond that the
 * lines would overflow and clip mid-grid — the caller should render a
 * record-style fallback instead of a broken table.
 */
export function tableFits(cols: number, maxWidth: number): boolean {
  return (COL_CHROME + 3) * cols + 1 <= maxWidth;
}

/** Normalize a cell: convert HTML `<br>` line breaks (GFM tables can't hold a
 * literal newline, so authors use `<br>` for in-cell breaks) to real newlines, then
 * strip inline markdown per line. Returns a (possibly multi-line) cell. */
function normCell(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .split("\n")
    .map(stripInline)
    .join("\n");
}

/**
 * Render a GFM table to a proper GRID (opencode-style): a `┌┬┐` top rule, the header
 * row (accent), a `├┼┤` divider, then each data row followed by a `├┼┤` inter-row
 * rule (the last closes with `└┴┘`). The UI draws the `│` borders in the border tone
 * and the cells in their role color. A cell's HTML `<br>` becomes a real in-cell line
 * break; inline markdown is stripped; overflowing cells **wrap** (no truncation).
 * Every ` cell ` and rule segment is `width+2` wide, so junctions align under `│`.
 */
export function renderTable(rows: string[][], align: Align[], maxWidth: number): TableLine[] {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const norm = rows.map((r) =>
    Array.from({ length: cols }, (_, c) => normCell((r[c] ?? "").trim())),
  );
  // A cell's width is its widest line (cells may now hold `<br>`-driven newlines).
  const cellW = (s: string): number => Math.max(1, ...s.split("\n").map(displayWidth));
  const w = Array.from({ length: cols }, (_, c) => Math.max(1, ...norm.map((r) => cellW(r[c]!))));

  // Shrink the widest column until the grid fits (min 3 wide so wrapping stays
  // legible). Chrome = per-column borders + padding. Overflow wraps, never truncates.
  const chrome = COL_CHROME * cols + 1;
  let total = chrome + w.reduce((a, b) => a + b, 0);
  while (total > maxWidth && Math.max(...w) > 3) {
    w[w.indexOf(Math.max(...w))]!--;
    total--;
  }

  const alignCell = (v: string, c: number): string => {
    const width = w[c]!;
    const pad = Math.max(0, width - displayWidth(v));
    const a = align[c] ?? "left";
    if (a === "right") return " ".repeat(pad) + v;
    if (a === "center") {
      const left = Math.floor(pad / 2);
      return " ".repeat(left) + v + " ".repeat(pad - left);
    }
    return v + " ".repeat(pad);
  };
  // A logical row → 1+ physical lines: split each cell on its `<br>` newlines, wrap
  // each segment to the column width, stack to the tallest cell, emit padded cells.
  const rowLines = (r: string[]): string[][] => {
    const wrapped = r.map((s, c) => s.split("\n").flatMap((part) => wrapCell(part, w[c]!)));
    const height = Math.max(1, ...wrapped.map((x) => x.length));
    const out: string[][] = [];
    for (let li = 0; li < height; li++) {
      out.push(wrapped.map((lines, c) => alignCell(lines[li] ?? "", c)));
    }
    return out;
  };
  // A box rule: `left` + per-column `─`×(width+2) joined by `mid` + `right`.
  const rule = (left: string, mid: string, right: string): string =>
    left + w.map((width) => "─".repeat(width + 2)).join(mid) + right;

  const out: TableLine[] = [];
  out.push({ role: "rule", text: rule("┌", "┬", "┐") });
  for (const cells of rowLines(norm[0]!)) out.push({ role: "header", cells });
  const data = norm.slice(1);
  out.push({
    role: "rule",
    text: rule(data.length ? "├" : "└", data.length ? "┼" : "┴", data.length ? "┤" : "┘"),
  });
  data.forEach((r, i) => {
    for (const cells of rowLines(r)) out.push({ role: "row", cells });
    const last = i === data.length - 1;
    out.push({ role: "rule", text: rule(last ? "└" : "├", last ? "┴" : "┼", last ? "┘" : "┤") });
  });
  return out;
}
