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
