import { test, expect } from "bun:test";
import {
  ACCENT_NAMES,
  ACCENT_PRESETS,
  accentNameOf,
  getTheme,
  isKnownTheme,
  THEMES,
  THEME_NAMES,
} from "./themes.ts";
// The engine consumes the SAME registry across the core/TUI boundary. Importing
// it from @vibe/shared here (not re-exported by themes.ts) proves the two paths
// resolve one object, and lets the parity test below assert the palettes cover it.
import {
  ACCENT_PRESETS as SHARED_ACCENT_PRESETS,
  THEME_NAMES as SHARED_THEME_NAMES,
} from "@vibe/shared";

test("themes.ts re-exports the SHARED registry — one source, no hand-synced copy", () => {
  // themes.ts's THEME_NAMES / ACCENT_PRESETS are the shared module's exports, so
  // the engine (which imports from @vibe/shared) and the TUI can never diverge.
  expect(THEME_NAMES).toBe(SHARED_THEME_NAMES);
  expect(ACCENT_PRESETS).toBe(SHARED_ACCENT_PRESETS);
});

test("every palette in THEMES covers EXACTLY the shared THEME_NAMES (drift fails CI)", () => {
  // This is the sync-enforcing test: a theme registered in @vibe/shared with no
  // palette here — or a palette added here without the shared name — fails. The
  // engine validates `/theme` against THEME_NAMES; the TUI must render each one.
  expect(new Set(Object.keys(THEMES))).toEqual(new Set(THEME_NAMES));
  for (const name of THEME_NAMES) {
    expect(THEMES[name]).toBeDefined();
    // isKnownTheme (core's KNOWN_THEMES analogue) agrees with the palette map.
    expect(isKnownTheme(name)).toBe(true);
  }
});

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

test("the default theme is royal-violet accented, DARK, and defines the new text tokens", () => {
  const d = getTheme("default");
  expect(d.primary).toBe("#8b5cf6");
  expect(d.accent).toBe("#8b5cf6");
  expect(d.heading).toBe("#8b5cf6");
  // The default must never drift light — its surfaces stay near-black.
  expect(d.background).toBe("#0a0a0a");
  expect(d.background).not.toBe(getTheme("light").background);
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

test("accent presets: valid hexes, purple (royal violet) is the default brand", () => {
  expect(ACCENT_NAMES.length).toBeGreaterThanOrEqual(6);
  for (const name of ACCENT_NAMES) {
    expect(ACCENT_PRESETS[name]).toMatch(/^#[0-9a-f]{6}$/);
  }
  expect(ACCENT_PRESETS.purple).toBe("#8b5cf6");
  expect(ACCENT_PRESETS.orange).toBe("#fab283");
  // The default theme carries the royal violet as its brand — the same hue as
  // the `purple` preset (so `/accent purple` is a no-op on the default).
  expect(ACCENT_PRESETS.purple).toBe(getTheme("default").primary);
  // Distinct swatches — two names must never set the same hue.
  expect(new Set(Object.values(ACCENT_PRESETS)).size).toBe(ACCENT_NAMES.length);
});

test("accentNameOf maps a hex back to its preset name (case-insensitive)", () => {
  expect(accentNameOf("#fab283")).toBe("orange");
  expect(accentNameOf("#FAB283")).toBe("orange");
  expect(accentNameOf("#8b5cf6")).toBe("purple");
  expect(accentNameOf("#70cbf4")).toBe("blue");
  expect(accentNameOf("#123456")).toBeUndefined();
  expect(accentNameOf(undefined)).toBeUndefined();
  expect(accentNameOf("")).toBeUndefined();
});
