/**
 * UI themes for the OpenTUI app — named palettes selectable with `/theme`.
 * Each palette maps the app's semantic line kinds to hex colors. The headless
 * REPL uses 16-color ANSI (see `ansi.ts`) and is theme-agnostic.
 */
export interface Palette {
  user: string;
  assistant: string;
  tool: string;
  notice: string;
  plan: string;
  subagent: string;
  add: string;
  del: string;
  ctx: string;
  taskDone: string;
  taskActive: string;
  taskPending: string;
  /** Accent for the status/footer bar. */
  accent: string;
  /** Brand/primary accent — the heavy left-gutter on user message blocks. */
  primary: string;
  /** Box borders (task panel, plan box, input). */
  border: string;
  /** Secondary text: footer hint, placeholder, tool-result lines. */
  muted: string;
  /** Inset panel background (user message block, menu surface). */
  panel: string;
  /** Raised surface for the text input field (lighter than panel). */
  elevated: string;
  /** Selected-row background + foreground in the slash-command menu. */
  selBg: string;
  selFg: string;
  /** Subtle background tints behind diff added/removed lines. */
  addBg: string;
  delBg: string;
}

/** Tokyo-Night-ish dark palette (the default). */
// Charcoal + monochrome + a single lavender accent. Neutral grey surfaces (no
// blue cast), near-white/grey text, and one accent hue (`primary`/`accent`,
// configurable via `accentColor`). The only other colors are functional: green/
// red on diffs, amber on warnings, and the plan/yolo mode hues (cyan/red) which
// appear only on the input line + mode pill.
const DEFAULT: Palette = {
  user: "#e6e6e6",
  assistant: "#e6e6e6",
  tool: "#7dcfff",
  notice: "#e0af68",
  plan: "#bb9af7",
  subagent: "#9ece6a",
  add: "#9ece6a",
  del: "#f7768e",
  ctx: "#8a8a92",
  taskDone: "#6a6a72",
  taskActive: "#bb9af7",
  taskPending: "#e6e6e6",
  accent: "#bb9af7",
  // The fixed brand hue: a lavender accent shown across the whole UI. Mode only
  // recolors the input line + mode pill (see modeColor). Override via accentColor.
  primary: "#bb9af7",
  border: "#34343a",
  muted: "#8a8a92",
  panel: "#161618",
  elevated: "#1e1e22",
  selBg: "#2a2a30",
  selFg: "#e6e6e6",
  addBg: "#15231a",
  delBg: "#26171c",
};

/** Light palette for bright terminals. */
const LIGHT: Palette = {
  user: "#2959aa",
  assistant: "#343b58",
  tool: "#0f7b9c",
  notice: "#8f5e15",
  plan: "#5a3e8e",
  subagent: "#385f0d",
  add: "#385f0d",
  del: "#a1113b",
  ctx: "#9699a3",
  taskDone: "#9699a3",
  taskActive: "#0f7b9c",
  taskPending: "#343b58",
  accent: "#2959aa",
  primary: "#2959aa",
  border: "#d0d4de",
  muted: "#9699a3",
  panel: "#eef1f8",
  elevated: "#e3e8f3",
  selBg: "#d3dcef",
  selFg: "#1a2540",
  addBg: "#e4f0e0",
  delBg: "#f6e0e6",
};

/** High-contrast palette for accessibility. */
const CONTRAST: Palette = {
  user: "#00d7ff",
  assistant: "#ffffff",
  tool: "#00ffff",
  notice: "#ffd700",
  plan: "#ff87ff",
  subagent: "#5fff00",
  add: "#5fff00",
  del: "#ff3b3b",
  ctx: "#a8a8a8",
  taskDone: "#a8a8a8",
  taskActive: "#00ffff",
  taskPending: "#ffffff",
  accent: "#00d7ff",
  primary: "#00d7ff",
  border: "#5f5f5f",
  muted: "#a8a8a8",
  panel: "#161616",
  elevated: "#242424",
  selBg: "#343434",
  selFg: "#ffffff",
  addBg: "#003000",
  delBg: "#3a0000",
};

/**
 * The opencode palette — a warm "peach on neutral graphite" scheme ported from
 * opencode's default theme. Its signature is the `#fab283` primary used for the
 * user-message gutter and menu selection.
 */
const OPENCODE: Palette = {
  user: "#5c9cf5",
  assistant: "#eeeeee",
  tool: "#56b6c2",
  notice: "#f5a742",
  plan: "#9d7cd8",
  subagent: "#7fd88f",
  add: "#4fd6be",
  del: "#c53b53",
  ctx: "#828bb8",
  taskDone: "#808080",
  taskActive: "#56b6c2",
  taskPending: "#eeeeee",
  accent: "#fab283",
  primary: "#fab283",
  border: "#3c3c3c",
  muted: "#808080",
  panel: "#141414",
  elevated: "#1e1e1e",
  selBg: "#2a2a2a",
  selFg: "#eeeeee",
  addBg: "#20303b",
  delBg: "#37222c",
};

export const THEMES: Record<string, Palette> = {
  default: DEFAULT,
  dark: DEFAULT,
  light: LIGHT,
  contrast: CONTRAST,
  opencode: OPENCODE,
};

/** All selectable theme names. */
export const THEME_NAMES: string[] = Object.keys(THEMES);

/** Resolve a theme name to its palette, falling back to the default. */
export function getTheme(name: string | undefined): Palette {
  return (name && THEMES[name]) || DEFAULT;
}

/** Whether `name` is a known theme. */
export function isKnownTheme(name: string): boolean {
  return name in THEMES;
}
