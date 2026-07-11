import { test, expect } from "bun:test";
import {
  richKind,
  parseChart,
  parseSeries,
  parseWeather,
  parseSearchResults,
  parseSources,
  weatherIcon,
  hostOf,
  barGlyphs,
  sparkline,
  brailleChart,
  pieGrid,
  sharePercents,
  compactNum,
  barChartLayout,
  sparkLayout,
  resamplePoints,
  pieLayout,
} from "./rich-blocks.ts";

// ── richKind ─────────────────────────────────────────────────────────────────
test("richKind maps fence languages (with aliases) to view kinds", () => {
  expect(richKind("chart")).toBe("bar");
  expect(richKind("bar")).toBe("bar");
  expect(richKind("BarChart")).toBe("bar");
  expect(richKind("line")).toBe("line");
  expect(richKind("sparkline")).toBe("sparkline");
  expect(richKind("pie")).toBe("pie");
  expect(richKind("donut")).toBe("pie");
  expect(richKind("weather")).toBe("weather");
  expect(richKind("sources")).toBe("sources");
  expect(richKind("references")).toBe("sources");
});
test("richKind ignores trailing attributes and returns null for code langs", () => {
  expect(richKind('chart title="Prices"')).toBe("bar");
  expect(richKind("ts")).toBeNull();
  expect(richKind("")).toBeNull();
});

// ── parseChart ───────────────────────────────────────────────────────────────
test("parseChart reads label:value lines and a title", () => {
  const { title, data } = parseChart("# Market cap\nBitcoin: 1200\nEthereum: 190\nSolana: 62");
  expect(title).toBe("Market cap");
  expect(data).toEqual([
    { label: "Bitcoin", value: 1200, display: "1200" },
    { label: "Ethereum", value: 190, display: "190" },
    { label: "Solana", value: 62, display: "62" },
  ]);
});
test("parseChart scales k/m/b/t suffixes but keeps the human display token", () => {
  const { data } = parseChart("BTC: $1.2T\nETH: $190B");
  expect(data[0]).toEqual({ label: "BTC", value: 1.2e12, display: "$1.2T" });
  expect(data[1]).toEqual({ label: "ETH", value: 190e9, display: "$190B" });
});
test("parseChart tolerates bullets, pipes, and thousands separators", () => {
  const { data } = parseChart("- Redux | 12,500\n* Zustand 3400");
  expect(data).toEqual([
    { label: "Redux", value: 12500, display: "12,500" },
    { label: "Zustand", value: 3400, display: "3400" },
  ]);
});
test("parseChart skips lines without a number", () => {
  expect(parseChart("just prose\nA: 5").data).toEqual([{ label: "A", value: 5, display: "5" }]);
});

// ── parseSeries ──────────────────────────────────────────────────────────────
test("parseSeries reads a bare numeric series", () => {
  const { series } = parseSeries("10 12 9 15 18");
  expect(series).toEqual([{ label: undefined, points: [10, 12, 9, 15, 18] }]);
});
test("parseSeries reads multiple labelled series (comma or space separated)", () => {
  const { series } = parseSeries("revenue: 10,12,14,20\ncost: 8 9 9 11");
  expect(series).toEqual([
    { label: "revenue", points: [10, 12, 14, 20] },
    { label: "cost", points: [8, 9, 9, 11] },
  ]);
});
test("parseSeries does not treat a leading number as a label", () => {
  // "2021: 5 6 7" — the label part "2021" IS a number, so it's not a label; every
  // number (including 2021) is a data point.
  const { series } = parseSeries("2021: 5 6 7");
  expect(series[0]!.label).toBeUndefined();
  expect(series[0]!.points).toEqual([2021, 5, 6, 7]);
});

// ── parseWeather ─────────────────────────────────────────────────────────────
test("parseWeather pulls known fields and keeps extras as chips", () => {
  const w = parseWeather(
    "location: San Francisco\ntemp: 62°F\ncondition: Partly Cloudy\nhigh: 68\nlow: 54\nhumidity: 71%\nwind: 12 mph",
  );
  expect(w.location).toBe("San Francisco");
  expect(w.temp).toBe("62°F");
  expect(w.condition).toBe("Partly Cloudy");
  expect(w.hi).toBe("68");
  expect(w.lo).toBe("54");
  expect(w.chips).toEqual([
    { label: "humidity", value: "71%" },
    { label: "wind", value: "12 mph" },
  ]);
});
test("parseWeather parses a forecast line into per-day entries", () => {
  const w = parseWeather("forecast: Mon 68/54 Sunny; Tue 70/55 Cloudy");
  expect(w.forecast).toEqual([
    { day: "Mon", hi: "68", lo: "54", cond: "Sunny" },
    { day: "Tue", hi: "70", lo: "55", cond: "Cloudy" },
  ]);
});
test("weatherIcon maps conditions to glyphs", () => {
  expect(weatherIcon("Sunny")).toBe("☀");
  expect(weatherIcon("Partly Cloudy")).toBe("⛅");
  expect(weatherIcon("Overcast")).toBe("☁");
  expect(weatherIcon("Rain showers")).toBe("☔");
  expect(weatherIcon("Thunderstorm")).toBe("⛈");
  expect(weatherIcon("Snow")).toBe("❄");
});

test("every weather glyph is BMP text-presentation (predictable width)", () => {
  // A supplementary-plane emoji (🌫/🌬) is double-width with spotty terminal
  // font coverage and would misalign the forecast columns.
  for (const cond of [
    "Foggy",
    "Windy",
    "Sunny",
    "Rain",
    "Snow",
    "Thunderstorm",
    "Overcast",
    "Haze",
    "",
  ]) {
    const glyph = weatherIcon(cond);
    expect(glyph.codePointAt(0)! <= 0xffff).toBe(true);
  }
});

// ── parseSources ─────────────────────────────────────────────────────────────
test("parseSources reads pipe-delimited cards", () => {
  const s = parseSources("Bitcoin hits high | coindesk.com | BTC surged past $58k.");
  expect(s[0]).toEqual({
    title: "Bitcoin hits high",
    domain: "coindesk.com",
    url: "coindesk.com",
    snippet: "BTC surged past $58k.",
  });
});
test("parseSources reads markdown links with a trailing snippet", () => {
  const s = parseSources("1. [The Merge](https://ethereum.org/merge) — move to proof-of-stake");
  expect(s[0]).toEqual({
    title: "The Merge",
    url: "https://ethereum.org/merge",
    domain: "ethereum.org",
    snippet: "move to proof-of-stake",
  });
});
test("parseSources reads a trailing bare URL", () => {
  const s = parseSources("Ethereum docs - https://docs.ethereum.org/intro");
  expect(s[0]!.title).toBe("Ethereum docs");
  expect(s[0]!.domain).toBe("docs.ethereum.org");
});
test("hostOf strips protocol and www", () => {
  expect(hostOf("https://www.example.com/path?q=1")).toBe("example.com");
  expect(hostOf("coindesk.com")).toBe("coindesk.com");
});

// ── parseSearchResults ───────────────────────────────────────────────────────
test("parseSearchResults turns numbered search output into source cards", () => {
  const out = parseSearchResults(
    [
      'Search results for "btc price"',
      "",
      "1. Bitcoin price today , BTC to USD live price , marketcap and ...",
      "   https://www.coindesk.com/price/bitcoin",
      "   The price of Bitcoin (BTC) is $58,021.09 today,",
      "   with a 24-hour trading volume of $16.48B.",
      "",
      "2. Bitcoin USD PRICE (BTC-USD) - Yahoo Finance",
      "   https://finance.yahoo.com/quote/BTC-USD/",
      "   The last known price of Bitcoin is 59,280.37 USD.",
    ].join("\n"),
  );
  expect(out.length).toBe(2);
  expect(out[0]!.title).toBe("Bitcoin price today, BTC to USD live price, marketcap and ...");
  expect(out[0]!.url).toBe("https://www.coindesk.com/price/bitcoin");
  expect(out[0]!.domain).toBe("coindesk.com");
  expect(out[0]!.snippet).toContain("24-hour trading volume");
  expect(out[1]!.domain).toBe("finance.yahoo.com");
});
test("parseSearchResults returns nothing for un-numbered output", () => {
  expect(parseSearchResults("plain tool output\nno entries here")).toEqual([]);
});

// ── barGlyphs ────────────────────────────────────────────────────────────────
test("barGlyphs renders full + partial eighth blocks", () => {
  expect(barGlyphs(1, 10)).toBe("██████████");
  expect(barGlyphs(0.5, 10)).toBe("█████");
  expect(barGlyphs(0, 10)).toBe("");
  // A tiny positive fraction still shows at least one sub-cell.
  expect(barGlyphs(0.001, 10).length).toBe(1);
  // A quarter of 4 cells = 1 cell exactly.
  expect(barGlyphs(0.25, 4)).toBe("█");
});
test("barGlyphs never exceeds the width", () => {
  const s = barGlyphs(2, 6); // clamped fraction
  expect([...s].length).toBeLessThanOrEqual(6);
});

// ── sparkline ────────────────────────────────────────────────────────────────
test("sparkline maps a series into 8 block levels", () => {
  const s = sparkline([0, 1, 2, 3, 4, 5, 6, 7]);
  expect([...s].length).toBe(8);
  expect(s[0]).toBe("▁"); // min → lowest block
  expect(s.at(-1)).toBe("█"); // max → full block
});
test("sparkline renders a flat series at a mid level (no divide-by-zero)", () => {
  expect(sparkline([5, 5, 5])).toBe("▄▄▄");
});

// ── brailleChart ─────────────────────────────────────────────────────────────
test("brailleChart returns h rows of w braille glyphs", () => {
  const rows = brailleChart([1, 3, 2, 5, 4, 6], 12, 4);
  expect(rows.length).toBe(4);
  for (const r of rows) {
    expect([...r].length).toBe(12);
    expect(/^[⠀-⣿]+$/.test(r)).toBe(true);
  }
  // A varying series draws SOMETHING (not an all-blank canvas).
  expect(
    rows
      .join("")
      .split("")
      .some((ch) => ch !== "⠀"),
  ).toBe(true);
});
test("brailleChart places a rising series' end above its start", () => {
  const rows = brailleChart([0, 100], 8, 4);
  const filledRows = rows.map((r, i) => ({ i, on: r !== "⠀".repeat(8) }));
  const first = filledRows.find((x) => x.on)!.i;
  // The topmost drawn row should be near the top (the series rose to its max).
  expect(first).toBeLessThan(rows.length);
});

// ── pieGrid ──────────────────────────────────────────────────────────────────
test("pieGrid fills the disc with a single slice for one value", () => {
  const grid = pieGrid([100], 12, 6);
  const inside = grid.flat().filter((v) => v >= 0);
  expect(inside.length).toBeGreaterThan(0);
  expect(inside.every((v) => v === 0)).toBe(true);
  // Corners fall outside the disc.
  expect(grid[0]![0]).toBe(-1);
});
test("pieGrid assigns every value a nonzero region and stays within bounds", () => {
  const grid = pieGrid([50, 30, 20], 24, 12);
  const seen = new Set(grid.flat().filter((v) => v >= 0));
  expect(seen.has(0)).toBe(true);
  expect(seen.has(1)).toBe(true);
  expect(seen.has(2)).toBe(true);
  expect(Math.max(...seen)).toBeLessThanOrEqual(2);
});
test("pieGrid donut punches a hole in the center", () => {
  const grid = pieGrid([100], 24, 12, { donut: true });
  const cx = 12;
  const cy = 6;
  expect(grid[cy]![cx]).toBe(-1); // center is hollow
});

// ── sharePercents ────────────────────────────────────────────────────────────
test("sharePercents sums to exactly 100 (largest-remainder)", () => {
  const p = sharePercents([1, 1, 1]);
  expect(p.reduce((a, b) => a + b, 0)).toBe(100);
  expect(p).toEqual([34, 33, 33]);
});
test("sharePercents handles an all-zero input without NaN", () => {
  expect(sharePercents([0, 0])).toEqual([0, 0]);
});

// ── compactNum ───────────────────────────────────────────────────────────────
test("compactNum abbreviates with a unit suffix", () => {
  expect(compactNum(950)).toBe("950");
  expect(compactNum(3400)).toBe("3.4k");
  expect(compactNum(1_200_000)).toBe("1.2M");
  expect(compactNum(1_200_000_000)).toBe("1.2B");
  expect(compactNum(2_000_000_000_000)).toBe("2T");
});

// ── Width budgets (narrow-terminal clamps) ───────────────────────────────────
// Row width per BarLayout: label + gap(2) + track + gap(2) + value.
const barRowWidth = (l: { labelW: number; track: number; valueW: number }) =>
  l.labelW + 2 + l.track + 2 + l.valueW;

test("barChartLayout never overflows a narrow width (the old track floor did)", () => {
  const data = [
    { label: "A very long label that used to overflow", display: "$1,234,567" },
    { label: "日本語のラベル名テスト", display: "42" },
  ];
  // Pre-clamp, width 31 gave track = max(6, 31-20-10-5) = 6 → a 40-cell row.
  for (const width of [12, 16, 20, 24, 31, 40, 60, 120]) {
    const l = barChartLayout(data, width);
    expect(l.labelW).toBeGreaterThanOrEqual(1);
    expect(l.valueW).toBeGreaterThanOrEqual(1);
    expect(l.track).toBeGreaterThanOrEqual(1);
    expect(barRowWidth(l)).toBeLessThanOrEqual(width);
  }
});
test("barChartLayout keeps the roomy budget on a wide terminal", () => {
  const l = barChartLayout([{ label: "BTC", display: "1200" }], 80);
  expect(l).toEqual({ labelW: 3, valueW: 4, track: 80 - 3 - 4 - 5 });
});

test("sparkLayout fits label + spark + range, dropping the range before the spark", () => {
  const series = [{ label: "requests per second", points: [1, 500, 120_000] }];
  const wide = sparkLayout(series, 60);
  expect(wide).toEqual({ labelW: 16, sparkW: 60 - 18 - 8, showRange: true }); // "1–120k" + 2-gap = 8
  // Narrow: the range goes first, then the label shrinks — the spark survives.
  const narrow = sparkLayout(series, 12);
  expect(narrow.showRange).toBe(false);
  expect(narrow.labelW + 2 + narrow.sparkW).toBeLessThanOrEqual(12);
  expect(narrow.sparkW).toBeGreaterThanOrEqual(4);
  // Unlabelled series spend no label column at all.
  const bare = sparkLayout([{ points: [1, 2, 3] }], 12);
  expect(bare.labelW).toBe(0);
  expect(bare.sparkW).toBeLessThanOrEqual(12);
});

test("resamplePoints downsamples a long series to the column budget", () => {
  const points = Array.from({ length: 500 }, (_, i) => i);
  const out = resamplePoints(points, 20);
  expect(out.length).toBe(20); // pre-clamp: sparkline() painted 500 cells
  expect(out[0]).toBe(0); // keeps the endpoints
  expect(out[19]).toBe(499);
  expect(resamplePoints([1, 2, 3], 20)).toEqual([1, 2, 3]); // fits — untouched
  expect(resamplePoints(points, 1)).toEqual([499]);
  expect(resamplePoints(points, 0)).toEqual([]);
});

test("pieLayout shrinks the legend label, then drops the disc, on narrow widths", () => {
  const labels = ["a very long slice label", "另一个很长的标签"];
  const wide = pieLayout(labels, 80);
  expect(wide.labelW).toBe(20);
  expect(wide.cols).toBe(22); // disc cap unchanged when there's room
  expect(wide.rows).toBe(11);
  // Mid: pre-clamp this was labelW 20 → disc 10 + legend 28 = a 40-cell row at
  // width 34; now the label yields and the whole view fits exactly.
  const mid = pieLayout(labels, 34);
  expect(mid.labelW).toBe(14);
  expect(mid.cols).toBeGreaterThanOrEqual(8);
  expect(mid.cols + 2 + mid.labelW + 8).toBeLessThanOrEqual(34);
  // Narrow: no legible disc fits → legend-only (cols 0), still inside the width.
  const narrow = pieLayout(labels, 16);
  expect(narrow.cols).toBe(0);
  expect(narrow.labelW + 8).toBeLessThanOrEqual(16);
});
