/**
 * Shared theme + accent registry — the single source of truth for the selectable
 * UI theme NAMES and the named accent presets (name → hex).
 *
 * These are pure serializable data that BOTH sides of the core/TUI boundary need:
 * the engine validates `/theme <name>` and resolves `/accent <name>` to a hex
 * (`@vibe/core` engine-commands), and the TUI renders the palettes + derives its
 * `/theme` and `/accent` menus (`@vibe/tui`). They used to be hand-maintained
 * parallel copies (engine-commands.ts `KNOWN_THEMES`/`ACCENT_PRESETS` and
 * tui/themes.ts) carrying "keep in sync" comments with nothing to enforce it;
 * hoisting the shared data here — both packages already depend on `@vibe/shared`,
 * so this respects the boundary (core still never imports the UI package) — kills
 * the duplication at the root. The FULL palettes (per-token hex maps) stay in
 * `@vibe/tui`: they are render-only structure the engine never needs, and tui's
 * `themes.test.ts` asserts its palette set covers EXACTLY `THEME_NAMES` so a new
 * theme registered on one side without the other fails CI.
 */

/**
 * Every selectable UI theme name, in menu order. `dark` is an alias of the
 * default palette (so both appear). The TUI keeps a palette per name; the engine
 * only validates membership.
 */
export const THEME_NAMES: string[] = [
  "default",
  "dark",
  "light",
  "contrast",
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
];

/**
 * Named accent presets for `/accent <name>` — a curated swatch row so switching
 * the chrome hue is one word, not a hex hunt. `purple` is the default theme's
 * royal-violet brand; `blue` is the historical Blue 300; `orange` is opencode's
 * signature peach; the rest round out a calm, terminal-proven set. Any 6-digit
 * hex still works via `/accent #rrggbb`. The engine resolves a name here to its
 * hex before emitting `accent-changed`, so the UIs always receive a concrete
 * hex and need no map of their own.
 */
export const ACCENT_PRESETS: Record<string, string> = {
  blue: "#70cbf4",
  purple: "#8b5cf6",
  orange: "#fab283",
  ember: "#ff966c",
  amber: "#e0af68",
  green: "#9ece6a",
  teal: "#2ac3de",
  violet: "#bb9af7",
  rose: "#f7768e",
  white: "#e6e6e6",
};

/** All selectable accent preset names, in menu order. */
export const ACCENT_NAMES: string[] = Object.keys(ACCENT_PRESETS);
