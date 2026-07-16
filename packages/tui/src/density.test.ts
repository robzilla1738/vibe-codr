import { test, expect } from "bun:test";
import {
  nextDensity,
  isTranscriptDensity,
  densityLabel,
  densityShort,
  toolCollapsed,
  showThinkingRows,
  thinkingCollapsed,
  DENSITY_LEVELS,
} from "./density.ts";

test("nextDensity cycles quiet → normal → verbose → quiet", () => {
  expect(nextDensity("quiet")).toBe("normal");
  expect(nextDensity("normal")).toBe("verbose");
  expect(nextDensity("verbose")).toBe("quiet");
});

test("isTranscriptDensity accepts only known levels", () => {
  for (const d of DENSITY_LEVELS) expect(isTranscriptDensity(d)).toBe(true);
  expect(isTranscriptDensity("loud")).toBe(false);
  expect(isTranscriptDensity("")).toBe(false);
});

test("densityLabel is non-empty for every level", () => {
  for (const d of DENSITY_LEVELS) expect(densityLabel(d).length).toBeGreaterThan(4);
});

test("densityShort is the bare level name", () => {
  for (const d of DENSITY_LEVELS) expect(densityShort(d)).toBe(d);
});

test("toolCollapsed: quiet always collapses", () => {
  expect(toolCollapsed("quiet", { collapsed: false, isError: true, isDiff: true })).toBe(true);
});

test("toolCollapsed: verbose opens error/diff even when flagged collapsed", () => {
  expect(toolCollapsed("verbose", { collapsed: true, isError: true, isDiff: false })).toBe(false);
  expect(toolCollapsed("verbose", { collapsed: true, isError: false, isDiff: true })).toBe(false);
  // Ordinary tool stays collapsed until the user expands.
  expect(toolCollapsed("verbose", { collapsed: true, isError: false, isDiff: false })).toBe(true);
});

test("toolCollapsed: normal honors the block flag", () => {
  expect(toolCollapsed("normal", { collapsed: true, isError: false, isDiff: false })).toBe(true);
  expect(toolCollapsed("normal", { collapsed: false, isError: false, isDiff: false })).toBe(false);
});

test("showThinkingRows is false only in quiet", () => {
  expect(showThinkingRows("quiet")).toBe(false);
  expect(showThinkingRows("normal")).toBe(true);
  expect(showThinkingRows("verbose")).toBe(true);
});

test("thinkingCollapsed: verbose always open", () => {
  expect(thinkingCollapsed("verbose", true)).toBe(false);
  expect(thinkingCollapsed("normal", true)).toBe(true);
  expect(thinkingCollapsed("quiet", true)).toBe(true);
});
