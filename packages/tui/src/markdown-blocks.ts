/**
 * Split a markdown reply into top-level blocks — prose, fenced code, GFM tables —
 * and render tables to clean box-drawing lines.
 *
 * Why: OpenTUI's `<markdown>` renderable has a layout bug where a code/table block
 * blanks its *sibling* prose (even across separate `<markdown>` instances). Since
 * coding replies constantly mix prose with code, that silently ate the prose. So
 * the TUI renders prose via `<markdown>` (which is reliable in isolation, keeping
 * inline bold/italic/code conceal) and renders code + tables itself from `<box>`/
 * `<text>` primitives. This module is the pure (testable, no-OpenTUI) core.
 */

export type Align = "left" | "right" | "center";

export type MdBlock =
  | { kind: "prose"; text: string }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "table"; rows: string[][]; align: Align[] };

/** A rendered table line, tagged so the UI can color borders/header/rows. */
export interface TableLine {
  role: "rule" | "header" | "row";
  text: string;
}

const len = (s: string): number => [...s].length;

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

/**
 * Render a table to clean box-drawing lines, columns aligned and fit within
 * `maxWidth` (cells truncated with `…` when the table would overflow).
 */
export function renderTable(rows: string[][], align: Align[], maxWidth: number): TableLine[] {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const norm = rows.map((r) => Array.from({ length: cols }, (_, c) => (r[c] ?? "").trim()));
  const w = Array.from({ length: cols }, (_, c) => Math.max(1, ...norm.map((r) => len(r[c]!))));

  // Shrink the widest column until the table fits. Chrome = `│`*(cols+1) + 2 pad/col.
  const chrome = cols + 1 + 2 * cols;
  let total = chrome + w.reduce((a, b) => a + b, 0);
  while (total > maxWidth && Math.max(...w) > 3) {
    w[w.indexOf(Math.max(...w))]!--;
    total--;
  }

  const cell = (s: string, c: number): string => {
    const width = w[c]!;
    let v = s;
    if (len(v) > width) v = `${[...v].slice(0, Math.max(1, width - 1)).join("")}…`;
    const pad = width - len(v);
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
  const dataRow = (r: string[]): string => `│${r.map((s, c) => ` ${cell(s, c)} `).join("│")}│`;

  const out: TableLine[] = [{ role: "rule", text: rule("┌", "┬", "┐") }];
  out.push({ role: "header", text: dataRow(norm[0]!) });
  out.push({ role: "rule", text: rule("├", "┼", "┤") });
  for (const r of norm.slice(1)) out.push({ role: "row", text: dataRow(r) });
  out.push({ role: "rule", text: rule("└", "┴", "┘") });
  return out;
}
