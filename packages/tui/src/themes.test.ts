import { test, expect } from "bun:test";
import { getTheme, isKnownTheme, THEME_NAMES } from "./themes.ts";

test("getTheme returns a distinct palette per known name", () => {
  expect(getTheme("light")).not.toBe(getTheme("default"));
  expect(getTheme("contrast")).not.toBe(getTheme("default"));
  // Same name resolves to the same palette object.
  expect(getTheme("light")).toBe(getTheme("light"));
});

test("getTheme falls back to default for unknown or missing names", () => {
  expect(getTheme("nope")).toBe(getTheme("default"));
  expect(getTheme(undefined)).toBe(getTheme("default"));
});

test("isKnownTheme reflects the registry", () => {
  expect(isKnownTheme("default")).toBe(true);
  expect(isKnownTheme("light")).toBe(true);
  expect(isKnownTheme("opencode")).toBe(true);
  expect(isKnownTheme("nope")).toBe(false);
});

test("the opencode theme ships with its signature warm primary", () => {
  const oc = getTheme("opencode");
  expect(oc).not.toBe(getTheme("default"));
  expect(oc.primary).toBe("#fab283");
  // The diff backgrounds are real tints, distinct from the panel surface.
  expect(oc.addBg).not.toBe(oc.panel);
  expect(oc.delBg).not.toBe(oc.panel);
});

test("every theme defines a full palette of color strings", () => {
  const keys = Object.keys(getTheme("default"));
  for (const name of THEME_NAMES) {
    const palette = getTheme(name) as unknown as Record<string, string>;
    for (const k of keys) {
      expect(typeof palette[k]).toBe("string");
    }
  }
});
