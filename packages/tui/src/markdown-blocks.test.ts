import { test, expect } from "bun:test";
import { splitMarkdown, renderTable, stripInline } from "./markdown-blocks.ts";

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

test("a header-without-delimiter stays prose (not a premature table)", () => {
  // While streaming, the header may arrive before the delimiter row.
  const b = splitMarkdown("| Name | Size |");
  expect(b).toEqual([{ kind: "prose", text: "| Name | Size |" }]);
});

test("renderTable produces a clean borderless table: header, rule, rows", () => {
  const lines = renderTable(
    [
      ["Name", "Size"],
      ["Redux", "large"],
    ],
    ["left", "right"],
    80,
  );
  // Header first (no top border), then a single rule, then rows.
  expect(lines[0]!.role).toBe("header");
  expect(lines[0]!.text).toContain("Name");
  expect(lines[1]!.role).toBe("rule");
  expect(lines[1]!.text).toMatch(/^─+$/); // a plain horizontal rule, no box corners
  expect(lines.at(-1)!.role).toBe("row");
  // No vertical bars / box corners anywhere (borderless).
  for (const l of lines) expect(l.text).not.toMatch(/[│┌┐└┘├┤┬┴┼]/);
  // Columns align: every line is the same visual width.
  const widths = new Set(lines.map((l) => [...l.text].length));
  expect(widths.size).toBe(1);
});

test("stripInline conceals bold/italic/code/strikethrough/links", () => {
  expect(stripInline("**Bitcoin (BTC)**")).toBe("Bitcoin (BTC)");
  expect(stripInline("*italic* and _also_")).toBe("italic and also");
  expect(stripInline("`code` and ~~gone~~")).toBe("code and gone");
  expect(stripInline("see [the docs](https://x.y/z)")).toBe("see the docs");
  expect(stripInline("plain")).toBe("plain");
});

test("renderTable conceals inline markdown in cells (no raw ** leaks)", () => {
  const lines = renderTable(
    [["**Metric**", "**BTC**"], ["**Supply**", "21M `hard cap`"]],
    ["left", "left"],
    80,
  );
  const body = lines.map((l) => l.text).join("\n");
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
  for (const l of lines) expect([...l.text].length).toBeLessThanOrEqual(18);
  expect(lines.some((l) => l.text.includes("…"))).toBe(false);
  // All the original words survive across the wrapped body lines.
  const body = lines.map((l) => l.text).join(" ");
  for (const word of ["long", "cell", "value", "overflows", "column"]) {
    expect(body).toContain(word);
  }
  // The wrapped row is taller than one line (a real wrap happened).
  expect(lines.filter((l) => l.role === "row").length).toBeGreaterThan(1);
});

test("every wrapped table line is the same visual width", () => {
  const lines = renderTable(
    [["Name", "Detail"], ["Alpha", "a longer detail that must wrap across lines"]],
    ["left", "left"],
    28,
  );
  const widths = new Set(lines.map((l) => [...l.text].length));
  expect(widths.size).toBe(1);
});
