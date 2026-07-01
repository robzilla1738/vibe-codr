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

test("the default theme is Blue 300 accented and defines the new text tokens", () => {
  const d = getTheme("default");
  expect(d.primary).toBe("#70cbf4");
  expect(d.accent).toBe("#70cbf4");
  expect(d.heading).toBe("#70cbf4");
  // gutter/code are their own tones, distinct from the accent and from borders.
  expect(d.gutter).not.toBe(d.primary);
  expect(d.gutter).not.toBe(d.border);
  expect(d.code).not.toBe(d.primary);
});

test("every theme defines the new gutter/heading/code text tokens", () => {
  for (const name of THEME_NAMES) {
    const p = getTheme(name);
    for (const k of ["gutter", "heading", "code"] as const) {
      expect(p[k]).toMatch(/^#[0-9a-f]{6}$/);
    }
  }
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
