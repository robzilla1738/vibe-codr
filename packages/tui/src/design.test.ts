import { test, expect } from "bun:test";
import {
  buildFooterHintSegs,
  contextLabel,
  contextMeter,
  densityChip,
  earlierTurnsLabel,
  footerHintSpec,
  INPUT_PLACEHOLDER,
  INTERRUPT_HINT,
  isNearNeutral,
  itemsHiddenLabel,
  modeHint,
  permissionTitle,
  PLAN_CARD_TITLE,
  wordmarkHue,
  workingLineWithInterrupt,
  workingStatusLabel,
} from "./design.ts";

test("densityChip is empty for normal, named for quiet/verbose", () => {
  expect(densityChip("normal")).toBe("");
  expect(densityChip("quiet")).toBe("quiet");
  expect(densityChip("verbose")).toBe("verbose");
});

test("contextMeter is empty under 1%, bar + percent otherwise", () => {
  expect(contextMeter(0)).toBe("");
  expect(contextMeter(0.5)).toBe("");
  expect(contextMeter(12)).toBe("▯▯▯▯ 12%");
  expect(contextMeter(50)).toMatch(/▮/);
  expect(contextMeter(50)).toContain("50%");
  expect(contextMeter(100)).toBe("▮▮▮▮ 100%");
  expect(contextMeter(25)).toBe("▮▯▯▯ 25%");
});

test("contextLabel keeps the legacy ctx N% form", () => {
  expect(contextLabel(0)).toBe("");
  expect(contextLabel(12)).toBe("ctx 12%");
});

test("wordmarkHue: accent wins; otherwise primary (no purple heading fallback)", () => {
  expect(
    wordmarkHue({ accent: "#ff8800", primary: "#f2f2f2", heading: "#8b5cf6" }),
  ).toBe("#ff8800");
  // Monochrome default chrome: white primary, not heading purple.
  expect(wordmarkHue({ primary: "#f2f2f2", heading: "#8b5cf6" })).toBe("#f2f2f2");
  expect(wordmarkHue({ primary: "#eeeeee" })).toBe("#eeeeee");
  // Saturated primary (opencode peach) keeps its own brand.
  expect(wordmarkHue({ primary: "#fab283", heading: "#8b5cf6" })).toBe("#fab283");
  expect(isNearNeutral("#f2f2f2")).toBe(true);
  expect(isNearNeutral("#fab283")).toBe(false);
});

test("modeHint describes each UiMode", () => {
  expect(modeHint("plan")).toContain("plan");
  expect(modeHint("execute")).toContain("ask");
  expect(modeHint("yolo")).toContain("without");
});

test("permissionTitle and plan fixed titles", () => {
  expect(permissionTitle("bash", 1)).toBe("Permission required · bash");
  expect(permissionTitle("bash", 3)).toBe("Permission required · bash · 1/3");
  expect(PLAN_CARD_TITLE).toContain("Plan · review & approve");
});

test("workingStatusLabel always starts with Working", () => {
  expect(workingStatusLabel(0)).toBe("Working…");
  expect(workingStatusLabel(3200)).toBe("Working… 3.2s");
  expect(workingStatusLabel(1000, "quiet")).toContain("Working");
  expect(workingStatusLabel(1000, "quiet")).toContain("quiet");
  expect(workingStatusLabel(1000, "normal")).not.toContain("quiet");
});

test("workingLineWithInterrupt includes Working and esc hint", () => {
  const line = workingLineWithInterrupt(2500);
  expect(line).toContain("Working");
  expect(line).toContain(INTERRUPT_HINT);
  expect(line).toContain("2.5s");
  expect(workingLineWithInterrupt(50, "verbose")).toContain("verbose");
});

test("footerHintSpec is priority-ordered with useful keys", () => {
  const keys = footerHintSpec().map((h) => h.key).join(" ");
  expect(keys).toContain("shift+tab");
  expect(keys).toContain("/");
  expect(keys).toContain("ctrl+d");
  expect(keys).toContain("click");
  const prios = footerHintSpec().map((h) => h.priority);
  expect(prios[0]).toBeLessThanOrEqual(prios[prios.length - 1]!);
});

test("buildFooterHintSegs never double-separates after a jobs prefix", () => {
  const colors = { lit: "L", dim: "D", notice: "N" };
  const idle = buildFooterHintSegs({ runningJobs: 0, ...colors });
  const idleText = idle.map((s) => s.t).join("");
  expect(idleText).toContain("shift+tab");
  expect(idleText).toContain("  ·  ");
  expect(idleText.includes("  ·    ·  ")).toBe(false);
  expect(idleText.startsWith("  ·  ")).toBe(false);

  const one = buildFooterHintSegs({ runningJobs: 1, ...colors });
  const oneText = one.map((s) => s.t).join("");
  expect(oneText).toContain("1 job");
  expect(oneText).toContain("(/jobs)");
  expect(oneText).toContain("shift+tab");
  expect(oneText.includes("  ·    ·  ")).toBe(false);
  // Separator is two spaces, mid-dot, two spaces.
  expect(oneText).toMatch(/\(\/jobs\) {2}· {2}shift\+tab/);
  const many = buildFooterHintSegs({ runningJobs: 3, ...colors });
  expect(many.map((s) => s.t).join("")).toContain("3 jobs");
  expect(many.map((s) => s.t).join("").includes("  ·    ·  ")).toBe(false);
});

test("fold labels are plural-aware", () => {
  expect(earlierTurnsLabel(1, 20)).toContain("1 earlier turn ·");
  expect(earlierTurnsLabel(6, 20)).toContain("6 earlier turns");
  expect(earlierTurnsLabel(6, 20)).toContain("load 6 more");
  expect(itemsHiddenLabel(1)).toContain("1 item hidden");
  expect(itemsHiddenLabel(3)).toContain("3 items hidden");
});

test("INPUT_PLACEHOLDER keeps smoke substring", () => {
  expect(INPUT_PLACEHOLDER).toContain("Send a message");
});
