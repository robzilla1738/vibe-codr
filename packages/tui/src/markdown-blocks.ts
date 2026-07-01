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

/** A rendered table line, tagged so the UI can color borders/header/rows. */
export interface TableLine {
  role: "rule" | "header" | "row";
  text: string;
}

const len = (s: string): number => [...s].length;

/**
 * Strip inline markdown (emphasis / code / links) for text we render OURSELVES —
 * table cells, headings, blockquotes. OpenTUI's native `<markdown>` conceals these
 * for prose, but our hand-rendered `<text>` primitives would otherwise show the raw
 * `**` / `*` / `` ` `` / `~~` / `[label](url)` markers. Bold is stripped before
 * italic so `**x**` doesn't leave a stray `*`.
 */
export function stripInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image ![alt](url) → alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link [text](url) → text
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
    .replace(/(\*|_)(.+?)\1/g, "$2") // italic
    .replace(/~~(.+?)~~/g, "$1") // strikethrough
    .replace(/`([^`]+)`/g, "$1") // inline code
    .trim();
}

/** A GFM delimiter row: `| --- | :--: |` (only `|`, `-`, `:`, spaces; has a `-`). */
function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  return t.includes("-") && /^\|?[\s:|-]+\|?$/.test(t) && t.replace(/[^|]/g, "").length >= 1;
}

/** Split a `| a | b |` row into trimmed cells (drops the optional outer pipes). */
function parseRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
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
  const lines = src.split("\n");
  const blocks: MdBlock[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    const text = prose.join("\n").replace(/^\n+|\n+$/g, "");
    if (text.trim()) blocks.push({ kind: "prose", text });
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      flushProse();
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
      continue;
    }
    // An ATX heading — `#`..`######` + at least one space + text. A lone `#` (no
    // space yet, mid-stream) stays prose until its text arrives. Headings inside a
    // fence never reach here (the code branch consumed them above).
    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (heading) {
      flushProse();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: stripInline(heading[2]!) });
      continue;
    }
    // A `>` blockquote — gather consecutive quoted lines, stripping the marker.
    if (/^\s*>/.test(line)) {
      flushProse();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) {
        quoted.push(stripInline((lines[i] ?? "").replace(/^\s*>[ \t]?/, "")));
        i++;
      }
      i--; // step back so the for-loop's ++ lands on the first non-quote line
      blocks.push({ kind: "quote", lines: quoted });
      continue;
    }
    if (line.includes("|") && isDelimiterRow(lines[i + 1] ?? "")) {
      flushProse();
      const rows: string[][] = [parseRow(line)];
      const align = parseAlign(lines[i + 1] ?? "");
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        rows.push(parseRow(lines[i] ?? ""));
        i++;
      }
      i--; // step back so the for-loop's ++ lands on the first non-table line
      blocks.push({ kind: "table", rows, align });
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return blocks;
}

/** Greedy word-wrap `s` to `width` columns; a word longer than `width` is
 * hard-broken. Always returns at least one (possibly empty) line. */
function wrapCell(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  let cur = "";
  for (let word of s.split(/\s+/).filter(Boolean)) {
    // Hard-break a single word that can't fit the column.
    while (len(word) > w) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push([...word].slice(0, w).join(""));
      word = [...word].slice(w).join("");
    }
    if (!word) continue;
    if (!cur) cur = word;
    else if (len(cur) + 1 + len(word) <= w) cur += ` ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur || lines.length === 0) lines.push(cur);
  return lines;
}

/**
 * Render a GFM table to clean box-drawing lines: inline markdown is stripped from
 * every cell, columns are aligned, and the whole table is fit within `maxWidth` by
 * **wrapping** overflowing cells across multiple lines (no truncation, no data
 * loss). Every emitted line is the same visual width.
 */
export function renderTable(rows: string[][], align: Align[], maxWidth: number): TableLine[] {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const norm = rows.map((r) => Array.from({ length: cols }, (_, c) => stripInline((r[c] ?? "").trim())));
  const w = Array.from({ length: cols }, (_, c) => Math.max(1, ...norm.map((r) => len(r[c]!))));

  // Shrink the widest column until the table fits (min 3 cols wide so wrapping
  // stays legible). Chrome = `│`*(cols+1) + 2 pad/col. Overflow now wraps, not truncates.
  const chrome = cols + 1 + 2 * cols;
  let total = chrome + w.reduce((a, b) => a + b, 0);
  while (total > maxWidth && Math.max(...w) > 3) {
    w[w.indexOf(Math.max(...w))]!--;
    total--;
  }

  const alignLine = (v: string, c: number): string => {
    const width = w[c]!;
    const pad = Math.max(0, width - len(v));
    const a = align[c] ?? "left";
    if (a === "right") return " ".repeat(pad) + v;
    if (a === "center") {
      const left = Math.floor(pad / 2);
      return " ".repeat(left) + v + " ".repeat(pad - left);
    }
    return v + " ".repeat(pad);
  };
  const rule = (l: string, m: string, r: string): string =>
    l + w.map((width) => "─".repeat(width + 2)).join(m) + r;
  // A logical row → 1+ physical lines: wrap each cell, then stack them to the row's
  // tallest cell, padding shorter cells with blank lines.
  const dataRows = (r: string[]): string[] => {
    const wrapped = r.map((s, c) => wrapCell(s, w[c]!));
    const height = Math.max(1, ...wrapped.map((x) => x.length));
    const out: string[] = [];
    for (let li = 0; li < height; li++) {
      out.push(`│${wrapped.map((lines, c) => ` ${alignLine(lines[li] ?? "", c)} `).join("│")}│`);
    }
    return out;
  };

  const out: TableLine[] = [{ role: "rule", text: rule("┌", "┬", "┐") }];
  for (const line of dataRows(norm[0]!)) out.push({ role: "header", text: line });
  out.push({ role: "rule", text: rule("├", "┼", "┤") });
  for (const r of norm.slice(1)) for (const line of dataRows(r)) out.push({ role: "row", text: line });
  out.push({ role: "rule", text: rule("└", "┴", "┘") });
  return out;
}
