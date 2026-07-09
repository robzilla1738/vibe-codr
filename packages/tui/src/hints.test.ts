import { test, expect } from "bun:test";
import { fitHintSegs, hintSegsWidth } from "./hints.ts";

test("fitHintSegs keeps everything when it fits", () => {
  const segs = [
    { t: "Enter", fg: "a", priority: 0 },
    { t: " accept", fg: "b", priority: 0 },
    { t: "  ·  scroll", fg: "c", priority: 2 },
  ];
  expect(fitHintSegs(segs, 80)).toEqual(segs);
});

test("fitHintSegs drops lowest-priority band first (never mid-token)", () => {
  const segs = [
    { t: "Enter", fg: "a", priority: 0 },
    { t: " accept & run", fg: "b", priority: 0 },
    { t: "  ·  ", fg: "c", priority: 1 },
    { t: "^Y", fg: "a", priority: 1 },
    { t: " run in yolo", fg: "b", priority: 1 },
    { t: "  ·  ", fg: "c", priority: 2 },
    { t: "scroll", fg: "a", priority: 2 },
    { t: " to read", fg: "b", priority: 2 },
  ];
  // Wide enough for p0+p1 but not p2.
  const fitted = fitHintSegs(segs, 40);
  const text = fitted.map((s) => s.t).join("");
  expect(text).toContain("Enter");
  expect(text).toContain("^Y");
  expect(text).not.toContain("scroll");
  // Never a clipped fragment.
  expect(text.includes("scro") && !text.includes("scroll")).toBe(false);
});

test("fitHintSegs drops p1 when only p0 fits", () => {
  const segs = [
    { t: "Enter accept", fg: "a", priority: 0 },
    { t: " · type to revise", fg: "b", priority: 1 },
    { t: " · scroll", fg: "c", priority: 2 },
  ];
  const fitted = fitHintSegs(segs, 14);
  expect(fitted.map((s) => s.t).join("")).toBe("Enter accept");
});

test("fitHintSegs returns empty for non-positive width", () => {
  expect(fitHintSegs([{ t: "x", fg: "a" }], 0)).toEqual([]);
  expect(fitHintSegs([{ t: "x", fg: "a" }], -1)).toEqual([]);
});

test("hintSegsWidth sums display widths", () => {
  expect(hintSegsWidth([{ t: "ab", fg: "x" }, { t: "cd", fg: "y" }])).toBe(4);
});
