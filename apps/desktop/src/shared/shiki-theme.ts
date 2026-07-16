/**
 * Map app theme names → Shiki bundled theme ids used by Streamdown CodeBlock.
 * Returns a [light, dark] pair (Streamdown / Shiki dual-theme order). We set both
 * slots to the same active theme so highlighting follows the app palette, not
 * OS `prefers-color-scheme`.
 */
import { getTheme } from "./themes";
import { paletteColorScheme } from "./theme-scheme";
import { THEME_NAMES } from "./theme-registry";

type ShikiPair = { dark: string; light: string };

/** Per-app-theme Shiki ids. Unknown names fall back to github. */
const SHIKI_BY_THEME: Record<string, ShikiPair> = {
  default: { dark: "github-dark", light: "github-light" },
  dark: { dark: "github-dark", light: "github-light" },
  light: { dark: "github-dark", light: "github-light" },
  contrast: { dark: "github-dark-high-contrast", light: "github-light-high-contrast" },
  tokyonight: { dark: "tokyo-night", light: "github-light" },
  catppuccin: { dark: "catppuccin-mocha", light: "catppuccin-latte" },
  gruvbox: { dark: "gruvbox-dark-medium", light: "gruvbox-light-medium" },
  nord: { dark: "nord", light: "github-light" },
  "one-dark": { dark: "one-dark-pro", light: "one-light" },
  dracula: { dark: "dracula", light: "github-light" },
  rosepine: { dark: "rose-pine", light: "rose-pine-dawn" },
  kanagawa: { dark: "kanagawa-wave", light: "kanagawa-lotus" },
  everforest: { dark: "everforest-dark", light: "everforest-light" },
  flexoki: { dark: "github-dark", light: "github-light" },
  vesper: { dark: "vesper", light: "github-light" },
};

const FALLBACK: ShikiPair = { dark: "github-dark", light: "github-light" };

/** Active Shiki theme id for the given app theme (scheme-aware). */
export function shikiThemeId(themeName?: string): string {
  const name = themeName && themeName in SHIKI_BY_THEME ? themeName : "default";
  const pair = SHIKI_BY_THEME[name] ?? FALLBACK;
  const scheme = paletteColorScheme(getTheme(themeName));
  return scheme === "light" ? pair.light : pair.dark;
}

/**
 * Streamdown `shikiTheme` prop: [light, dark]. Both slots are the active theme
 * so fences match `data-scheme` regardless of OS preference.
 */
export function shikiThemeFor(themeName?: string): [string, string] {
  const id = shikiThemeId(themeName);
  return [id, id];
}

/** Every registered app theme has a Shiki mapping (CI guard). */
export function shikiThemesCoverRegistry(): boolean {
  return THEME_NAMES.every((name) => name in SHIKI_BY_THEME);
}
