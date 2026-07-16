import { test, expect } from "bun:test";
import { unifiedDiff } from "./diff.ts";

test("identical input yields an empty diff", () => {
  const d = unifiedDiff("a\nb\nc\n", "a\nb\nc\n");
  expect(d.text).toBe("");
  expect(d.added).toBe(0);
  expect(d.removed).toBe(0);
});

test("a single-line change shows one + and one -", () => {
  const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n");
  expect(d.added).toBe(1);
  expect(d.removed).toBe(1);
  expect(d.text).toContain("-b");
  expect(d.text).toContain("+B");
  expect(d.text).toContain(" a"); // context line retained
});

test("pure additions to a new file count every line", () => {
  const d = unifiedDiff("", "x\ny\n");
  expect(d.removed).toBe(0);
  expect(d.added).toBe(2);
  expect(d.text).toContain("+x");
  expect(d.text).toContain("+y");
});

test("far-apart changes are separated by an elision marker", () => {
  const before = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
  const after = before.replace("line0", "CHANGED0").replace("line29", "CHANGED29");
  const d = unifiedDiff(before, after);
  expect(d.text).toContain("…"); // the unchanged middle is collapsed
  expect(d.text).toContain("+CHANGED0");
  expect(d.text).toContain("+CHANGED29");
});

test("a huge file falls back to a coarse diff instead of OOMing on the LCS matrix", () => {
  // ~20k lines each way would allocate a ~400M-cell LCS matrix (multi-GB). The
  // guard must bail to a coarse diff with accurate +/- counts and no matrix.
  const n = 20_000;
  const before = Array.from({ length: n }, (_, i) => `line${i}`).join("\n");
  // Change 3 lines: 3 removed + 3 added; the rest identical (multiset match).
  const after = before
    .replace("line0\n", "CHANGED0\n")
    .replace("line100\n", "CHANGED100\n")
    .replace("line19999", "CHANGED19999");
  const d = unifiedDiff(before, after);
  expect(d.added).toBe(3);
  expect(d.removed).toBe(3);
  expect(d.text).toContain("diff omitted");
});

test("a file right under the cap still diffs fully", () => {
  const before = Array.from({ length: 2000 }, (_, i) => `l${i}`).join("\n");
  const after = before.replace("l0\n", "X0\n");
  const d = unifiedDiff(before, after);
  expect(d.added).toBe(1);
  expect(d.removed).toBe(1);
  expect(d.text).toContain("+X0");
});
