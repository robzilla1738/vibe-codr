import type { Palette } from "./themes";

/** sRGB relative luminance (0–1) for a `#rrggbb` hex. Non-hex → 0. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 0;
  const channels = match[1]!.match(/.{2}/g)!.map((part) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

export function paletteColorScheme(palette: Palette): "light" | "dark" {
  return relativeLuminance(palette.background) > 0.45 ? "light" : "dark";
}

/** Foreground that stays readable on a solid accent / selection fill. */
export function contrastOn(hex: string): string {
  return relativeLuminance(hex) > 0.45 ? "#0a0a0a" : "#eeeeee";
}

export type ChromeAccentVars = {
  accent: string;
  primary: string;
  selBg: string;
  selFg: string;
  heading: string;
  ring: string;
  focus: string;
  mode: string;
};

/**
 * Map `/accent` (or palette chrome) onto selection + focus tokens so menus,
 * headings, and rings stay in lockstep with the active accent.
 */
export function resolveChromeAccent(
  palette: Palette,
  accentOverride?: string,
): ChromeAccentVars {
  const trimmed = accentOverride?.trim();
  if (!trimmed) {
    return {
      accent: palette.accent,
      primary: palette.primary,
      selBg: palette.selBg,
      selFg: palette.selFg,
      heading: palette.heading,
      ring: palette.accent,
      focus: palette.accent,
      mode: palette.accent,
    };
  }
  return {
    accent: trimmed,
    primary: trimmed,
    selBg: trimmed,
    selFg: contrastOn(trimmed),
    heading: trimmed,
    ring: trimmed,
    focus: trimmed,
    mode: trimmed,
  };
}
