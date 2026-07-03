import { test, expect } from "bun:test";
import { splitMarkdown, renderTable, stripInline, displayWidth, tableFits, type TableLine } from "./markdown-blocks.ts";

/** Reconstruct a grid table line's visual text (the box rules verbatim; a
 * header/row as its cells wrapped by the outer + inner `│` borders the UI draws) so
 * width/content assertions work on the structured grid output. */
const lineText = (l: TableLine): string => (l.role === "rule" ? l.text : `│ ${l.cells.join(" │ ")} │`);
/** Terminal-cell display width of a reconstructed line (CJK/emoji-aware). */
const lineWidth = (l: TableLine): number => displayWidth(lineText(l));

test("plain prose is a single prose block", () => {
  const b = splitMarkdown("Hello there.\n\nSecond paragraph.");
  expect(b).toEqual([{ kind: "prose", text: "Hello there.\n\nSecond paragraph." }]);
});

test("a fenced code block is split out from surrounding prose", () => {
  const b = splitMarkdown("before\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n\nafter");
  expect(b.map((x) => x.kind)).toEqual(["prose", "code", "prose"]);
  expect(b[0]).toEqual({ kind: "prose", text: "before" });
  expect(b[1]).toEqual({ kind: "code", lang: "ts", lines: ["const x = 1;", "const y = 2;"] });
  expect(b[2]).toEqual({ kind: "prose", text: "after" });
});

test("an unterminated (streaming) code fence keeps the rest as code", () => {
  const b = splitMarkdown("intro\n\n```py\nprint(1)\nprint(2)");
  expect(b.map((x) => x.kind)).toEqual(["prose", "code"]);
  expect(b[1]).toEqual({ kind: "code", lang: "py", lines: ["print(1)", "print(2)"] });
});

test("ATX headings are split out with their level, between prose", () => {
  const b = splitMarkdown("intro\n\n## Setup\n\nrun it\n\n### Details\ndeep");
  expect(b.map((x) => x.kind)).toEqual(["prose", "heading", "prose", "heading", "prose"]);
  expect(b[1]).toEqual({ kind: "heading", level: 2, text: "Setup" });
  expect(b[3]).toEqual({ kind: "heading", level: 3, text: "Details" });
});

test("a lone '#' with no text stays prose (streaming partial)", () => {
  expect(splitMarkdown("#")).toEqual([{ kind: "prose", text: "#" }]);
  // ...and becomes a heading once the space + text arrive.
  expect(splitMarkdown("# Title")).toEqual([{ kind: "heading", level: 1, text: "Title" }]);
});

test("a '#' inside a code fence is NOT a heading", () => {
  const b = splitMarkdown("```sh\n# a shell comment\necho hi\n```");
  expect(b.map((x) => x.kind)).toEqual(["code"]);
  expect(b[0]).toEqual({ kind: "code", lang: "sh", lines: ["# a shell comment", "echo hi"] });
});

test("consecutive blockquote lines group into one quote block, marker stripped", () => {
  const b = splitMarkdown("before\n\n> note one\n> note two\n\nafter");
  expect(b.map((x) => x.kind)).toEqual(["prose", "quote", "prose"]);
  expect(b[1]).toEqual({ kind: "quote", lines: ["note one", "note two"] });
});

test("a GFM table is split out, with alignment, between prose", () => {
  const src = "pick one:\n\n| Name | Size |\n| :-- | --: |\n| Redux | large |\n| Zustand | tiny |\n\ndone";
  const b = splitMarkdown(src);
  expect(b.map((x) => x.kind)).toEqual(["prose", "table", "prose"]);
  const table = b[1] as Extract<(typeof b)[number], { kind: "table" }>;
  expect(table.rows).toEqual([
    ["Name", "Size"],
    ["Redux", "large"],
    ["Zustand", "tiny"],
  ]);
  expect(table.align).toEqual(["left", "right"]);
  expect(b[2]).toEqual({ kind: "prose", text: "done" });
});

test("a GFM escaped pipe in a cell is a literal | , not a column break", () => {
  const src = "| Op | Meaning |\n| --- | --- |\n| a \\| b | alternation |";
  const b = splitMarkdown(src);
  const table = b.find((x) => x.kind === "table") as Extract<
    (typeof b)[number],
    { kind: "table" }
  >;
  expect(table).toBeDefined();
  // Two cells (the escaped pipe stays inside cell 1 as a literal "|"), no stray backslash.
  expect(table.rows).toEqual([
    ["Op", "Meaning"],
    ["a | b", "alternation"],
  ]);
});

test("a doubled backslash before a pipe is an escaped backslash + a real delimiter", () => {
  // `a\\|b`: literal backslash, then a column break → cells "a\" and "b" (GFM).
  const src = "| x | y |\n| --- | --- |\n| a\\\\|b | z |";
  const b = splitMarkdown(src);
  const table = b.find((x) => x.kind === "table") as Extract<
    (typeof b)[number],
    { kind: "table" }
  >;
  expect(table.rows).toEqual([
    ["x", "y"],
    ["a\\", "b", "z"],
  ]);
});

test("a header-without-delimiter stays prose (not a premature table)", () => {
  // While streaming, the header may arrive before the delimiter row.
  const b = splitMarkdown("| Name | Size |");
  expect(b).toEqual([{ kind: "prose", text: "| Name | Size |" }]);
});

test("renderTable produces a grid: top rule, header, ├┼┤ dividers, rows, bottom rule", () => {
  const lines = renderTable(
    [
      ["Name", "Size"],
      ["Redux", "large"],
      ["Zustand", "tiny"],
    ],
    ["left", "right"],
    80,
  );
  // Top rule → header → divider → row → inter-row rule → row → bottom rule.
  expect((lines[0] as { text: string }).text).toMatch(/^┌[─┬]+┐$/);
  expect(lines[1]!.role).toBe("header");
  expect((lines[1] as { cells: string[] }).cells.join(" ")).toContain("Name");
  expect((lines[2] as { text: string }).text).toMatch(/^├[─┼]+┤$/);
  expect((lines.at(-1) as { text: string }).text).toMatch(/^└[─┴]+┘$/);
  // There is at least one inter-row divider between the two data rows.
  expect(lines.filter((l) => l.role === "rule").length).toBe(4); // top, header-div, inter-row, bottom
  // Two columns → each header/row line carries two cells (UI draws the `│` borders).
  for (const l of lines) if (l.role !== "rule") expect(l.cells.length).toBe(2);
  // Columns align: every reconstructed line (framed cells or a box rule) is one width.
  expect(new Set(lines.map(lineWidth)).size).toBe(1);
});

test("renderTable converts a cell's <br> into real in-cell line breaks", () => {
  const lines = renderTable(
    [
      ["Aspect", "Notes"],
      ["Pros", "fast<br>simple<br>tested"],
    ],
    ["left", "left"],
    80,
  );
  // The <br>-joined cell spans THREE physical row lines (one per segment), none of
  // which contains a literal `<br>`.
  const rowLines = lines.filter((l) => l.role === "row") as { cells: string[] }[];
  expect(rowLines.length).toBe(3);
  const joined = rowLines.map((r) => r.cells.join(" ")).join("\n");
  expect(joined).not.toContain("<br>");
  for (const seg of ["fast", "simple", "tested"]) expect(joined).toContain(seg);
});

test("stripInline conceals bold/italic/code/strikethrough/links", () => {
  expect(stripInline("**Bitcoin (BTC)**")).toBe("Bitcoin (BTC)");
  expect(stripInline("*italic* and _also_")).toBe("italic and also");
  expect(stripInline("`code` and ~~gone~~")).toBe("code and gone");
  expect(stripInline("see [the docs](https://x.y/z)")).toBe("see the docs");
  expect(stripInline("plain")).toBe("plain");
});

test("stripInline preserves intraword underscores in identifiers", () => {
  // Regression: `_`-emphasis used to eat identifier underscores in table cells /
  // headings / blockquotes, turning `max_retry_count` into `maxretrycount`.
  expect(stripInline("max_retry_count")).toBe("max_retry_count");
  expect(stripInline("get_user_by_id")).toBe("get_user_by_id");
  expect(stripInline("call `set__value` in db__table")).toBe("call set__value in db__table");
  // Genuine `_`/`__` emphasis (flanked by non-word chars) is still concealed.
  expect(stripInline("this is _emphasis here_ ok")).toBe("this is emphasis here ok");
  expect(stripInline("__strong__ start")).toBe("strong start");
  // A mix: identifier survives, real emphasis is stripped.
  expect(stripInline("_note_: use api_key_id")).toBe("note: use api_key_id");
});

test("stripInline italic honors CommonMark flanking (globs/math survive)", () => {
  // The `*` pass must not eat literal asterisk pairs: content must start AND end
  // on a non-space. (Guards the `[^*]`-bounded rewrite that fixed the O(n²) freeze.)
  expect(stripInline("*emphasis* here")).toBe("emphasis here");
  expect(stripInline("*.ts and *.js globs")).toBe("*.ts and *.js globs");
  expect(stripInline("2 * 3 and 4 * 5")).toBe("2 * 3 and 4 * 5");
  expect(stripInline("*a* and *b* pair")).toBe("a and b pair");
});

test("stripInline is LINEAR on a `*`-dense line (adversarial P7-W2)", () => {
  // `\S(?:.*?\S)?` backtracked O(n²) on `*`-flanked tokens; stripInline runs on
  // the TUI render thread per streamed markdown chunk, so a ~96KB line froze the
  // UI ~1.8s. The `[^*]`-bounded body can't scan past the next `*` → linear.
  const evil = "*a ".repeat(32000); // ~96KB single line
  const t0 = performance.now();
  const out = stripInline(evil);
  expect(performance.now() - t0).toBeLessThan(500); // was ~1800ms
  expect(typeof out).toBe("string");
});

test("renderTable conceals inline markdown in cells (no raw ** leaks)", () => {
  const lines = renderTable(
    [["**Metric**", "**BTC**"], ["**Supply**", "21M `hard cap`"]],
    ["left", "left"],
    80,
  );
  const body = lines.map(lineText).join("\n");
  expect(body).not.toContain("**");
  expect(body).not.toContain("`");
  expect(body).toContain("Metric");
  expect(body).toContain("hard cap");
});

test("renderTable wraps (not truncates) cells to fit a narrow width, losing no text", () => {
  const lines = renderTable(
    [["Column"], ["a very long cell value that overflows the column"]],
    ["left"],
    18,
  );
  // Every line fits the width, and nothing is truncated with an ellipsis.
  for (const l of lines) expect(lineWidth(l)).toBeLessThanOrEqual(18);
  expect(lines.some((l) => lineText(l).includes("…"))).toBe(false);
  // All the original words survive across the wrapped body lines.
  const body = lines.map(lineText).join(" ");
  for (const word of ["long", "cell", "value", "overflows", "column"]) {
    expect(body).toContain(word);
  }
  // The wrapped row is taller than one line (a real wrap happened).
  expect(lines.filter((l) => l.role === "row").length).toBeGreaterThan(1);
});

test("a wrapped list-item cell hangs its continuation under the text, not the marker", () => {
  const lines = renderTable(
    [["Pros"], ["• Smart contracts plus a huge dapp ecosystem"]],
    ["left"],
    24,
  );
  const rows = lines.filter((l) => l.role === "row") as { cells: string[] }[];
  expect(rows.length).toBeGreaterThan(1);
  // The first physical line carries the bullet; every continuation is indented
  // past the `• ` marker so the wrapped words align under the item text.
  expect(rows[0]!.cells[0]!.startsWith("• ")).toBe(true);
  for (const r of rows.slice(1)) {
    const cell = r.cells[0]!;
    if (!cell.trim()) continue; // padding row from a sibling column
    expect(cell.startsWith("  ")).toBe(true);
    expect(cell.trimStart().startsWith("•")).toBe(false);
  }
});

test("a numbered list-item cell also hangs its wrap (1. / 12) markers)", () => {
  const lines = renderTable(
    [["Steps"], ["12. resolve the pricing catalog and cache it for a day"]],
    ["left"],
    26,
  );
  const rows = lines.filter((l) => l.role === "row") as { cells: string[] }[];
  expect(rows.length).toBeGreaterThan(1);
  expect(rows[0]!.cells[0]!.startsWith("12. ")).toBe(true);
  for (const r of rows.slice(1)) expect(r.cells[0]!.startsWith("    ")).toBe(true);
});

test("every wrapped table line is the same visual width", () => {
  const lines = renderTable(
    [["Name", "Detail"], ["Alpha", "a longer detail that must wrap across lines"]],
    ["left", "left"],
    28,
  );
  expect(new Set(lines.map(lineWidth)).size).toBe(1);
});

test("renderTable aligns columns by DISPLAY width so CJK/emoji cells don't desync the grid", () => {
  // 语言 is 2 code points but 4 terminal columns; a naive len() would under-pad
  // column 0 and drift every ` │ ` right of the `┼` junction.
  const lines = renderTable(
    [
      ["Lang", "Name"],
      ["语言", "Chinese"],
      ["en", "English"],
    ],
    ["left", "left"],
    80,
  );
  // Column 0 must be 4 display cells wide (max of "Lang"=4 and "语言"=4).
  const header = lines.find((l) => l.role === "header") as { cells: string[] };
  expect(displayWidth(header.cells[0]!)).toBe(4);
  // Every line has the same DISPLAY width → separators sit under the rule's ┼.
  expect(new Set(lines.map(lineWidth)).size).toBe(1);
});

test("renderTable preserves a cell's internal spacing when it fits the column", () => {
  const lines = renderTable([["x"], ["a    b"]], ["left"], 20);
  const row = lines.find((l) => l.role === "row") as { cells: string[] };
  // The four spaces survive (no greedy re-flow collapsing them to one).
  expect(row.cells[0]).toContain("a    b");
});

test("stripInline preserves literal asterisk pairs — globs and math are NOT italics", () => {
  // Regression: the italic pass ate the text between any two `*`, silently
  // corrupting glob patterns and multiplication in headings/cells/quotes.
  expect(stripInline("Files: *.ts and *.js")).toBe("Files: *.ts and *.js");
  expect(stripInline("2 * 3 and 4 * 5")).toBe("2 * 3 and 4 * 5");
  expect(stripInline("match *.log and *.tmp")).toBe("match *.log and *.tmp");
  // Real emphasis (content flanked by non-space) still conceals.
  expect(stripInline("*emphasis*")).toBe("emphasis");
  expect(stripInline("a *real emphasis* here")).toBe("a real emphasis here");
});

test("nested blockquotes flatten instead of showing the inner marker", () => {
  const blocks = splitMarkdown("> outer\n> > nested deeper");
  expect(blocks).toHaveLength(1);
  const q = blocks[0]!;
  expect(q.kind).toBe("quote");
  expect(q.kind === "quote" && q.lines).toEqual(["outer", "nested deeper"]);
});

test("tableFits: the 3-cell column floor decides when a grid physically fits", () => {
  // 2 cols → min 13; 13 cols → min 79 (> the 78-col max budget of a wide column).
  expect(tableFits(2, 13)).toBe(true);
  expect(tableFits(2, 12)).toBe(false);
  expect(tableFits(13, 78)).toBe(false);
  expect(tableFits(7, 43)).toBe(true);
  expect(tableFits(7, 42)).toBe(false);
});

test("displayWidth measures grapheme clusters as single glyphs", () => {
  expect(displayWidth("🇺🇸")).toBe(2); // flag = 2 regional indicators, ONE glyph
  expect(displayWidth("👨‍👩‍👧")).toBe(2); // ZWJ family
  expect(displayWidth("👍🏽")).toBe(2); // skin-tone modifier
  expect(displayWidth("☀️")).toBe(2); // VS16 upgrades a narrow base to emoji
  // The fast path is untouched: plain ASCII + CJK still sum per codepoint.
  expect(displayWidth("ab")).toBe(2);
  expect(displayWidth("日本")).toBe(4);
});
