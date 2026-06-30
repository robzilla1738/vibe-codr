import { test, expect } from "bun:test";
import { splitMarkdown, renderTable } from "./markdown-blocks.ts";

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

test("renderTable produces an aligned, fitted box-drawing table", () => {
  const lines = renderTable(
    [
      ["Name", "Size"],
      ["Redux", "large"],
    ],
    ["left", "right"],
    80,
  );
  expect(lines[0]!.role).toBe("rule");
  expect(lines[0]!.text.startsWith("┌") && lines[0]!.text.endsWith("┐")).toBe(true);
  expect(lines[1]!.role).toBe("header");
  expect(lines[1]!.text).toContain("Name");
  // Every rendered line is the same visual width (a well-formed table).
  const widths = new Set(lines.map((l) => [...l.text].length));
  expect(widths.size).toBe(1);
  // The closing rule caps the box.
  expect(lines.at(-1)!.text.startsWith("└")).toBe(true);
});

test("renderTable truncates cells to fit a narrow width", () => {
  const lines = renderTable(
    [["Column"], ["a-very-long-cell-value-that-overflows"]],
    ["left"],
    16,
  );
  for (const l of lines) expect([...l.text].length).toBeLessThanOrEqual(16);
  expect(lines.some((l) => l.text.includes("…"))).toBe(true);
});
