/**
 * Rich data views for assistant replies — the "incredible out of the box"
 * renderers. The model emits a fenced code block tagged with a view language
 * (```chart / ```line / ```pie / ```weather / ```sources) holding a tiny, forgiving
 * data format; this module parses that body and produces pure render primitives:
 * horizontal bar glyphs, a braille line-chart canvas, a circular pie grid, block
 * sparklines, weather fields, and source cards. app.tsx maps the primitives onto
 * OpenTUI `<box>`/`<text>` with palette colors.
 *
 * Everything here is pure (no OpenTUI/Solid, no color hex) so it is unit-tested
 * directly and shared unchanged by the screenshot generator. Colors come from the
 * palette's `series` ramp, indexed by the caller.
 */

import { displayWidth } from "./markdown-blocks";

/** The kind of rich view a fenced-block language selects. */
export type RichKind = "bar" | "line" | "sparkline" | "pie" | "weather" | "sources";

/** Map a fence language token to a rich view kind (case-insensitive, aliased), or
 * null for an ordinary code block. Only the first whitespace-delimited word counts,
 * so ```chart title="Prices"``` still resolves to a bar chart. */
export function richKind(lang: string): RichKind | null {
  const l = lang.trim().toLowerCase().split(/\s+/)[0] ?? "";
  switch (l) {
    case "chart":
    case "bar":
    case "bars":
    case "barchart":
      return "bar";
    case "line":
    case "linechart":
    case "plot":
      return "line";
    case "spark":
    case "sparkline":
    case "sparklines":
      return "sparkline";
    case "pie":
    case "donut":
    case "doughnut":
      return "pie";
    case "weather":
    case "forecast":
      return "weather";
    case "sources":
    case "citations":
    case "references":
      return "sources";
    default:
      return null;
  }
}

// ── Shared parsing helpers ───────────────────────────────────────────────────

/** Parse a numeric token (stripping thousands separators + spaces) → a finite
 * number, or null. */
function toNum(s: string): number | null {
  const n = Number(s.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/** Pull the LAST number-like token out of a line (optionally with a currency
 * prefix and a k/m/b/t/% magnitude suffix), returning both the scaled numeric
 * value and the original display token — so a bar can be sized by value while its
 * end-label keeps the human form (`$1.2T`). */
function lastNumber(line: string): { value: number; display: string; index: number } | null {
  const re = /([$€£¥]?)\s*(-?\d[\d,\s]*(?:\.\d+)?)\s*([kmbtKMBT%]?)/g;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(line)) !== null) {
    // Skip empty/degenerate matches so the loop always advances.
    if (m[0].trim() === "") {
      re.lastIndex++;
      continue;
    }
    last = m;
  }
  if (!last) return null;
  const base = toNum(last[2]!);
  if (base === null) return null;
  const suffix = (last[3] ?? "").toLowerCase();
  const mult = suffix && suffix !== "%" ? (SUFFIX[suffix] ?? 1) : 1;
  const sym = last[1] ?? "";
  const numText = last[2]!.replace(/\s/g, "");
  const display = `${sym}${numText}${last[3] ?? ""}`;
  return { value: base * mult, display, index: last.index };
}

/** Strip a leading list marker (`- `, `* `, `1. `, `1) `) + surrounding space. */
function stripBullet(s: string): string {
  return s.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "").trim();
}

/** A `title:` / `# Title` line at the top of a body, if present. Returns the title
 * and the remaining lines. */
function takeTitle(lines: string[]): { title?: string; rest: string[] } {
  const rest = lines.slice();
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!.trim();
    if (!t) continue;
    const h = /^#\s+(.*)$/.exec(t);
    const kv = /^title\s*[:=]\s*(.*)$/i.exec(t);
    if (h) {
      rest.splice(i, 1);
      return { title: h[1]!.trim(), rest };
    }
    if (kv) {
      rest.splice(i, 1);
      return { title: kv[1]!.trim(), rest };
    }
    return { rest };
  }
  return { rest };
}

// ── Bar chart / pie: label → value data ──────────────────────────────────────

export interface Datum {
  label: string;
  value: number;
  /** The value's original human form for the end-label (`$1.2T`, `72%`). */
  display: string;
}
export interface ChartData {
  title?: string;
  data: Datum[];
}

/** Parse `Label: value` (or `Label  value`, `Label | value`) lines into labelled
 * data. Lines without a number are skipped; a `title:`/`# ` line becomes the title.
 * Shared by the bar chart and the pie chart. */
export function parseChart(body: string): ChartData {
  const { title, rest } = takeTitle(body.split("\n"));
  const data: Datum[] = [];
  for (const raw of rest) {
    const line = stripBullet(raw);
    if (!line) continue;
    const num = lastNumber(line);
    if (!num) continue;
    const label = line
      .slice(0, num.index)
      .replace(/[\s:|,=–—-]+$/, "")
      .trim();
    if (!label) continue;
    data.push({ label, value: num.value, display: num.display });
  }
  return { title, data };
}

// ── Line / sparkline: one or more numeric series ─────────────────────────────

export interface Series {
  label?: string;
  points: number[];
}
export interface SeriesData {
  title?: string;
  series: Series[];
}

/** Parse numeric series for a line/sparkline chart. Each non-empty line is either
 * `label: n n n …` / `label: n,n,n` or a bare run of numbers (an unlabelled
 * series). A `title:`/`# ` line becomes the title. */
export function parseSeries(body: string): SeriesData {
  const { title, rest } = takeTitle(body.split("\n"));
  const series: Series[] = [];
  for (const raw of rest) {
    const line = raw.trim();
    if (!line) continue;
    // A `label:` prefix, where the label part isn't itself just a number.
    let label: string | undefined;
    let nums = line;
    const colon = /^([^:]+):\s*(.*)$/.exec(line);
    if (colon && toNum(colon[1]!.trim()) === null) {
      label = stripBullet(colon[1]!).trim() || undefined;
      nums = colon[2]!;
    }
    // Commas separate points in a series (unlike a chart datum, where they're
    // thousands separators), so the token match excludes them.
    const points = (nums.match(/-?\d+(?:\.\d+)?/g) ?? [])
      .map(toNum)
      .filter((n): n is number => n !== null);
    if (points.length) series.push({ label, points });
  }
  return { title, series };
}

// ── Weather card ─────────────────────────────────────────────────────────────

export interface WeatherDay {
  day: string;
  hi?: string;
  lo?: string;
  cond?: string;
}
export interface WeatherData {
  location?: string;
  temp?: string;
  condition?: string;
  hi?: string;
  lo?: string;
  /** Extra key/value chips (humidity, wind, UV, …) preserved in order. */
  chips: { label: string; value: string }[];
  forecast: WeatherDay[];
}

/** Parse `key: value` weather lines into a card model. Known keys populate named
 * fields; the rest become chips. A `forecast:` line (`Mon 68/54 Sunny; Tue …`)
 * parses into per-day entries. */
export function parseWeather(body: string): WeatherData {
  const out: WeatherData = { chips: [], forecast: [] };
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.trim().toLowerCase();
    const val = m[2]!.trim();
    if (!val) continue;
    if (/^(location|place|city|where)$/.test(key)) out.location = val;
    else if (/^(temp|temperature|now|current)$/.test(key)) out.temp = val;
    else if (/^(condition|conditions|summary|sky|weather)$/.test(key)) out.condition = val;
    else if (/^(high|hi|max)$/.test(key)) out.hi = val;
    else if (/^(low|lo|min)$/.test(key)) out.lo = val;
    else if (key === "forecast") out.forecast = parseForecast(val);
    else out.chips.push({ label: m[1]!.trim(), value: val });
  }
  return out;
}

/** `Mon 68/54 Sunny; Tue 70/55 Cloudy` → per-day forecast entries. */
function parseForecast(s: string): WeatherDay[] {
  return s
    .split(/[;|]/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      const parts = seg.split(/\s+/);
      const day = parts.shift() ?? "";
      const rest = parts.join(" ");
      const hl = /(-?\d+°?[a-z]*)\s*\/\s*(-?\d+°?[a-z]*)/i.exec(rest);
      const cond = hl ? rest.replace(hl[0]!, "").trim() : rest;
      return { day, hi: hl?.[1], lo: hl?.[2], cond: cond || undefined };
    });
}

/** A weather glyph for a free-text condition. Text-presentation BMP symbols so
 * the width is predictable across terminals. */
export function weatherIcon(condition: string | undefined): string {
  const c = (condition ?? "").toLowerCase();
  if (/(thunder|storm|lightning)/.test(c)) return "⛈";
  if (/(snow|sleet|flurr|blizzard|ice)/.test(c)) return "❄";
  if (/(rain|drizzle|shower|wet)/.test(c)) return "☔";
  // Fog/wind stay BMP too (`🌫`/`🌬` are supplementary-plane emoji — double-width
  // with spotty terminal-font coverage, the exact problem this table avoids).
  if (/(fog|mist|haze|smoke)/.test(c)) return "≋";
  if (/(part|few|scatter|broken|intermittent)/.test(c) && /cloud/.test(c)) return "⛅";
  if (/(cloud|overcast|grey|gray)/.test(c)) return "☁";
  if (/(clear|sunny|sun|fair)/.test(c)) return "☀";
  if (/wind|breez|gust/.test(c)) return "≈";
  return "⛅";
}

// ── Source / citation cards ──────────────────────────────────────────────────

export interface Source {
  title: string;
  url?: string;
  domain?: string;
  snippet?: string;
}

/** The bare host of a URL, without protocol or leading `www.`. */
export function hostOf(url: string): string {
  const m = /^(?:[a-z]+:\/\/)?(?:www\.)?([^/\s?#]+)/i.exec(url.trim());
  return m ? m[1]! : "";
}

/** Parse source lines into cards. Accepts, per line (most specific first):
 *   `Title | domain.com | snippet`
 *   `[Title](https://url) — snippet`  (markdown link)
 *   `Title - https://url`             (trailing bare URL)
 *   `Title`                           (title only)
 * Leading `1.`/`- ` markers are stripped. */
export function parseSources(body: string): Source[] {
  const sources: Source[] = [];
  for (const raw of body.split("\n")) {
    const line = stripBullet(raw);
    if (!line) continue;
    if (line.includes("|")) {
      const [title, domain, snippet] = line.split("|").map((s) => s.trim());
      sources.push({
        title: title || "(untitled)",
        domain: domain || undefined,
        snippet: snippet || undefined,
        url: domain && /\./.test(domain) ? domain : undefined,
      });
      continue;
    }
    const link = /\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/.exec(line);
    if (link) {
      const url = link[2]!.trim();
      sources.push({
        title: link[1]!.trim(),
        url,
        domain: hostOf(url) || undefined,
        snippet: link[3]!.replace(/^[\s—–:-]+/, "").trim() || undefined,
      });
      continue;
    }
    const bare = /(https?:\/\/\S+)/i.exec(line);
    if (bare) {
      const url = bare[1]!;
      const title = line
        .slice(0, bare.index)
        .replace(/[\s—–:-]+$/, "")
        .trim();
      const after = line
        .slice(bare.index + url.length)
        .replace(/^[\s—–:-]+/, "")
        .trim();
      sources.push({
        title: title || hostOf(url),
        url,
        domain: hostOf(url) || undefined,
        snippet: after || undefined,
      });
      continue;
    }
    sources.push({ title: line });
  }
  return sources;
}

/**
 * Parse a web-search TOOL's raw output ("Search results for …" then numbered
 * entries of title / URL / snippet lines) into source cards, so the expanded
 * view renders as the same clean source treatment as ```sources``` blocks
 * instead of dumped text. Lines before the first numbered entry (the preamble)
 * are skipped; within an entry, the first URL-ish line is the link and every
 * other line joins the snippet.
 */
export function parseSearchResults(text: string): Source[] {
  const sources: Source[] = [];
  let cur: Source | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (cur) sources.push(cur);
      // Tidy the title: collapse the " , " spacing artifacts search output has.
      cur = { title: numbered[1]!.replace(/\s+,/g, ",").trim() };
      continue;
    }
    if (!cur) continue; // preamble ("Search results for …")
    const url = /^(https?:\/\/\S+)$/i.exec(line);
    if (url && !cur.url) {
      cur.url = url[1]!;
      cur.domain = hostOf(url[1]!) || undefined;
      continue;
    }
    cur.snippet = cur.snippet ? `${cur.snippet} ${line}` : line;
  }
  if (cur) sources.push(cur);
  return sources;
}

// ── Render primitives ────────────────────────────────────────────────────────

/** Eighth-block glyphs for sub-cell bar precision (1/8 … 7/8 of a cell). */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** A horizontal bar for `fraction` (0..1) of `width` cells, using eighth-blocks for
 * a smooth sub-cell end. Always renders ≥1 sub-cell for a positive fraction so a
 * tiny-but-nonzero value is still visible. */
export function barGlyphs(fraction: number, width: number): string {
  const w = Math.max(1, Math.floor(width));
  const f = Math.max(0, Math.min(1, fraction));
  let eighths = Math.round(f * w * 8);
  if (f > 0 && eighths === 0) eighths = 1; // keep tiny values visible
  eighths = Math.min(eighths, w * 8);
  const full = Math.floor(eighths / 8);
  const rem = eighths % 8;
  return "█".repeat(full) + (rem ? EIGHTHS[rem]! : "");
}

/** 8-level block sparkline: each point mapped into `▁▂▃▄▅▆▇█` by its share of the
 * series range. A flat series renders as a mid-level bar. */
const SPARK = "▁▂▃▄▅▆▇█";
export function sparkline(points: number[]): string {
  if (points.length === 0) return "";
  const min = Math.min(...points);
  const max = Math.max(...points);
  if (max === min) return SPARK[3]!.repeat(points.length);
  return points
    .map((v) => {
      const level = Math.round(((v - min) / (max - min)) * (SPARK.length - 1));
      return SPARK[Math.max(0, Math.min(SPARK.length - 1, level))]!;
    })
    .join("");
}

// Braille dot bit per (row 0..3 top→bottom, col 0..1 left→right).
const BRAILLE_BASE = 0x2800;
const DOT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

/** Bresenham line between two dot coordinates, calling `plot` for each dot. */
function plotLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plot: (x: number, y: number) => void,
): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * Render a numeric series as a braille line chart: `w` cells wide × `h` cells tall
 * (each cell packs 2×4 dots, so the effective resolution is 2w × 4h). Consecutive
 * points are connected. Returns `h` strings of `w` braille glyphs (top row first).
 * A flat or single-point series is centered vertically.
 */
export function brailleChart(points: number[], w: number, h: number): string[] {
  const W = Math.max(1, Math.floor(w));
  const H = Math.max(1, Math.floor(h));
  const dotsW = W * 2;
  const dotsH = H * 4;
  const grid: number[][] = Array.from({ length: H }, () => Array<number>(W).fill(0));
  const set = (dx: number, dy: number) => {
    if (dx < 0 || dy < 0 || dx >= dotsW || dy >= dotsH) return;
    grid[Math.floor(dy / 4)]![Math.floor(dx / 2)]! |= DOT[dy % 4]![dx % 2]!;
  };
  const n = points.length;
  if (n > 0) {
    let min = Math.min(...points);
    let max = Math.max(...points);
    if (max === min) {
      max = min + 1;
      min = min - 1; // center a flat line
    }
    const px = (i: number) =>
      n === 1 ? Math.floor((dotsW - 1) / 2) : Math.round((i / (n - 1)) * (dotsW - 1));
    const py = (v: number) => Math.round((1 - (v - min) / (max - min)) * (dotsH - 1));
    let prevX = px(0);
    let prevY = py(points[0]!);
    set(prevX, prevY);
    for (let i = 1; i < n; i++) {
      const x = px(i);
      const y = py(points[i]!);
      plotLine(prevX, prevY, x, y, set);
      prevX = x;
      prevY = y;
    }
  }
  return grid.map((row) => row.map((bits) => String.fromCodePoint(BRAILLE_BASE + bits)).join(""));
}

/**
 * Rasterize a pie/donut to a `rows`×`cols` grid of slice indices (or -1 outside
 * the disc). Slices start at 12 o'clock and go clockwise, sized by each value's
 * share of the total. For a round result on a terminal's ~1:2 cell aspect, pass
 * `cols ≈ 2·rows`. `donut` punches a centered hole.
 */
export function pieGrid(
  values: number[],
  cols: number,
  rows: number,
  opts: { donut?: boolean } = {},
): number[][] {
  const C = Math.max(1, Math.floor(cols));
  const R = Math.max(1, Math.floor(rows));
  const grid: number[][] = Array.from({ length: R }, () => Array<number>(C).fill(-1));
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return grid;
  const bounds: number[] = [];
  let acc = 0;
  for (const v of values) {
    acc += Math.max(0, v) / total;
    bounds.push(acc);
  }
  const inner = opts.donut ? 0.42 : 0;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const nx = (c + 0.5 - C / 2) / (C / 2);
      const ny = (r + 0.5 - R / 2) / (R / 2);
      const dist = Math.sqrt(nx * nx + ny * ny);
      if (dist > 1 || dist < inner) continue;
      // 0 at top (12 o'clock), increasing clockwise, normalized to [0,1).
      let a = Math.atan2(nx, -ny) / (2 * Math.PI);
      if (a < 0) a += 1;
      let slice = bounds.findIndex((b) => a < b);
      if (slice < 0) slice = values.length - 1;
      grid[r]![c] = slice;
    }
  }
  return grid;
}

/** Integer percentages for `values` that sum to exactly 100 (largest-remainder
 * rounding), so a pie/legend never shows 99% or 101%. */
export function sharePercents(values: number[]): number[] {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (Math.max(0, v) / total) * 100);
  const floor = raw.map((r) => Math.floor(r));
  let remainder = 100 - floor.reduce((a, b) => a + b, 0);
  // Hand the leftover points to the largest fractional parts, biggest first.
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  const out = floor.slice();
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i]!++;
    remainder--;
  }
  return out;
}

// ── Width budgets (narrow-terminal clamps) ───────────────────────────────────
// Pure column math for the chart renderers in app.tsx. Each budget guarantees
// its row can NEVER overflow `width` — the old fixed floors (bar track ≥ 6,
// pie disc ≥ 10, one spark glyph per point) pushed the right-hand columns past
// the edge on a narrow terminal, where the renderer hard-clips them. Shrink
// order: the label column first, then the value/range column, and the
// bar/spark track absorbs the rest. All widths are display CELLS (CJK/emoji
// labels measure 2), never string lengths.

export interface BarLayout {
  /** Label column (ellipsize labels into this). */
  labelW: number;
  /** Right-aligned value column. */
  valueW: number;
  /** Bar track width (≥ 1). */
  track: number;
}

/** Column budget for a bar-chart row — `label··bar…gap··value` + 1 slack cell.
 * Invariant (width ≥ 10): labelW + 2 + track + 2 + valueW ≤ width. */
export function barChartLayout(
  data: { label: string; display: string }[],
  width: number,
): BarLayout {
  let labelW = Math.min(20, Math.max(1, ...data.map((d) => displayWidth(d.label))));
  let valueW = Math.max(1, ...data.map((d) => displayWidth(d.display)));
  const budget = Math.max(4, width - 6); // leave the 2+2 gaps + ≥1 track + slack
  if (labelW + valueW > budget) {
    labelW = Math.max(3, Math.min(labelW, budget - valueW));
    valueW = Math.max(1, Math.min(valueW, budget - labelW));
  }
  return { labelW, valueW, track: Math.max(1, width - labelW - valueW - 5) };
}

/** The `min–max` range text of a sparkline row (compact numbers). */
export function sparkRange(points: number[]): string {
  return `${compactNum(Math.min(...points))}–${compactNum(Math.max(...points))}`;
}

export interface SparkLayout {
  /** Label column (0 = no series in this set is labelled). */
  labelW: number;
  /** Cells available for the spark glyphs (resample points into this). */
  sparkW: number;
  /** Whether the `  min–max` range suffix still fits. */
  showRange: boolean;
}

/** Column budget for sparkline rows — `label··spark··range`. The range column
 * is dropped before the spark shrinks below ~4 glyphs; the label shrinks last.
 * Invariant (width ≥ 12): labelW + 2 + sparkW + (range ? rangeW : 0) ≤ width. */
export function sparkLayout(
  series: { label?: string; points: number[] }[],
  width: number,
): SparkLayout {
  const hasLabel = series.some((s) => s.label);
  let labelW = hasLabel
    ? Math.min(16, Math.max(1, ...series.map((s) => displayWidth(s.label ?? ""))))
    : 0;
  // Range chrome: the 2-cell gap + the widest `min–max` text across the series.
  const rangeW =
    2 +
    Math.max(0, ...series.map((s) => (s.points.length ? displayWidth(sparkRange(s.points)) : 0)));
  const chrome = () => (labelW > 0 ? labelW + 2 : 0);
  let showRange = true;
  let sparkW = width - chrome() - rangeW;
  if (sparkW < 4) {
    showRange = false;
    sparkW = width - chrome();
  }
  if (sparkW < 4 && labelW > 0) {
    labelW = Math.max(3, Math.min(labelW, width - 2 - 4));
    sparkW = width - chrome();
  }
  return { labelW, sparkW: Math.max(1, sparkW), showRange };
}

/** Downsample `points` to at most `max` entries — evenly spaced, keeping the
 * first and last — so a long series renders one glyph per COLUMN instead of one
 * per point (a 500-point series used to paint a 500-cell row). A series that
 * already fits is returned as-is. */
export function resamplePoints(points: number[], max: number): number[] {
  if (max <= 0) return [];
  if (points.length <= max) return points;
  if (max === 1) return [points[points.length - 1]!];
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]!);
  }
  return out;
}

export interface PieLayout {
  /** Legend label column. */
  labelW: number;
  /** Disc columns (0 = too narrow for a disc; render the legend alone). */
  cols: number;
  /** Disc rows. */
  rows: number;
}

/** Column budget for the pie view — disc + 2-cell gap + legend (`■ label··pct%`
 * = labelW + 8 cells). The label shrinks first (down to 3); below 8 disc
 * columns the disc is dropped entirely — a 6-cell "circle" reads as noise, and
 * the legend alone still carries the data. */
export function pieLayout(labels: string[], width: number): PieLayout {
  const natural = Math.max(1, ...labels.map((l) => displayWidth(l)));
  // Reserve disc(10) + gap(2) + legend chrome(8) before giving the label room.
  const labelW = Math.min(20, natural, Math.max(3, width - 20));
  const avail = width - (labelW + 8) - 2;
  const cols = Math.min(22, avail % 2 === 0 ? avail : avail - 1);
  if (cols < 8) return { labelW, cols: 0, rows: 0 };
  return { labelW, cols, rows: Math.max(5, Math.round(cols / 2)) };
}

/** Compact number for value labels: `1.2M`, `3.4k`, `950`. Preserves a provided
 * display token (e.g. `$1.2T`, `72%`) verbatim. */
export function compactNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${trim(n / 1e12)}T`;
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}k`;
  return `${trim(n)}`;
}
function trim(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? `${r}` : r.toFixed(1);
}
