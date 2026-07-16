import { test, expect } from "bun:test";
import { ESSENTIAL_KEYS, formatKeysHelp } from "./keys-help.ts";

test("ESSENTIAL_KEYS covers the chords the TUI actually binds", () => {
  const blob = ESSENTIAL_KEYS.map((k) => k.keys).join(" ");
  for (const need of [
    "Shift+Tab",
    "Esc",
    "Ctrl+O",
    "Ctrl+T",
    "Ctrl+D",
    "Ctrl+G",
    "Ctrl+V",
    "@",
    "/",
  ]) {
    expect(blob).toContain(need);
  }
});

test("formatKeysHelp is multi-line and mentions density + mouse", () => {
  const text = formatKeysHelp();
  expect(text).toContain("Keyboard");
  expect(text).toContain("Shift+Tab");
  expect(text).toContain("/details");
  expect(text).toContain("/mouse");
  expect(text.split("\n").length).toBeGreaterThan(8);
});
