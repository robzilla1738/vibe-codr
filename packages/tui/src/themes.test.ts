import { test, expect } from "bun:test";
import {
  ACCENT_NAMES,
  ACCENT_PRESETS,
  accentNameOf,
  getTheme,
  isKnownTheme,
  THEME_NAMES,
} from "./themes.ts";

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
  const keys = Object.keys(getTheme("default")).filter((k) => k !== "series");
  for (const name of THEME_NAMES) {
    const palette = getTheme(name) as unknown as Record<string, string>;
    for (const k of keys) {
      expect(typeof palette[k]).toBe("string");
    }
  }
});

test("every theme defines a series ramp of ≥4 distinct hex hues (for charts)", () => {
  for (const name of THEME_NAMES) {
    const { series } = getTheme(name);
    expect(Array.isArray(series)).toBe(true);
    expect(series.length).toBeGreaterThanOrEqual(4);
    for (const c of series) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    // Distinct hues so adjacent chart series never read as the same color.
    expect(new Set(series).size).toBe(series.length);
  }
});

test("the ported classics are registered with their signature palettes", () => {
  for (const name of [
    "tokyonight",
    "catppuccin",
    "gruvbox",
    "nord",
    "one-dark",
    "dracula",
    "rosepine",
    "kanagawa",
    "everforest",
    "flexoki",
    "vesper",
  ]) {
    expect(isKnownTheme(name)).toBe(true);
    expect(getTheme(name)).not.toBe(getTheme("default"));
  }
  // Spot-check the signatures: each theme carries its OWN backdrop + primary.
  expect(getTheme("tokyonight").background).toBe("#1a1b26");
  expect(getTheme("gruvbox").background).toBe("#282828");
  expect(getTheme("dracula").primary).toBe("#bd93f9");
  // The orange-forward options the accent work leans on.
  expect(getTheme("flexoki").primary).toBe("#da702c");
  expect(getTheme("vesper").primary).toBe("#ffc799");
});

test("every theme keeps panel/elevated raised surfaces distinct from the backdrop", () => {
  for (const name of THEME_NAMES) {
    const p = getTheme(name);
    expect(p.panel).not.toBe(p.background);
    expect(p.elevated).not.toBe(p.background);
    expect(p.selBg).not.toBe(p.background);
  }
});

test("accent presets: valid hexes, orange is opencode's peach, blue is the default", () => {
  expect(ACCENT_NAMES.length).toBeGreaterThanOrEqual(6);
  for (const name of ACCENT_NAMES) {
    expect(ACCENT_PRESETS[name]).toMatch(/^#[0-9a-f]{6}$/);
  }
  expect(ACCENT_PRESETS.orange).toBe("#fab283");
  expect(ACCENT_PRESETS.blue).toBe(getTheme("default").primary);
  // Distinct swatches — two names must never set the same hue.
  expect(new Set(Object.values(ACCENT_PRESETS)).size).toBe(ACCENT_NAMES.length);
});

test("accentNameOf maps a hex back to its preset name (case-insensitive)", () => {
  expect(accentNameOf("#fab283")).toBe("orange");
  expect(accentNameOf("#FAB283")).toBe("orange");
  expect(accentNameOf("#70cbf4")).toBe("blue");
  expect(accentNameOf("#123456")).toBeUndefined();
  expect(accentNameOf(undefined)).toBeUndefined();
  expect(accentNameOf("")).toBeUndefined();
});
