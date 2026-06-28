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
}

/** Tokyo-Night-ish dark palette (the default). */
const DEFAULT: Palette = {
  user: "#7aa2f7",
  assistant: "#c0caf5",
  tool: "#7dcfff",
  notice: "#e0af68",
  plan: "#bb9af7",
  subagent: "#9ece6a",
  add: "#9ece6a",
  del: "#f7768e",
  ctx: "#565f89",
  taskDone: "#565f89",
  taskActive: "#7dcfff",
  taskPending: "#c0caf5",
  accent: "#7aa2f7",
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
};

export const THEMES: Record<string, Palette> = {
  default: DEFAULT,
  dark: DEFAULT,
  light: LIGHT,
  contrast: CONTRAST,
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
