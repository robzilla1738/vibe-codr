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
  /** App background painted behind everything (else the terminal backdrop). */
  background: string;
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
  /** Calm left-gutter tone for tool-step + subagent threads (one flat tone, no
   * per-step rotation). */
  gutter: string;
  /** Markdown headings + table header row. */
  heading: string;
  /** Fenced code-block text (distinct from the vivid chrome accent). */
  code: string;
  /** A harmonious ramp of distinct hues for data views (bar/line/pie series,
   * source-card accents, weather chips) — cycled by index so a multi-series chart
   * reads as clean, differentiable categories rather than one flat color. */
  series: string[];
}

/** Black + Blue-300 dark palette (the default). */
// Black background + neutral grey CHROME BORDERS (input frame, panels), with a
// single Blue 300 (#70cbf4) ACCENT reserved for titles + markers: panel titles,
// the `❯` user marker + gutter, the active task/step, the selected menu row, the
// input caret, and the mode chip (ASK blue / PLAN green / YOLO red). The wordmark
// sweeps a light→deep shade of that same blue; tool/subagent threads share one
// calm muted `gutter` tone (no rainbow rotation). Neutral charcoal surfaces
// (panel/elevated) are raised on the black; green/red stay functional on diffs,
// amber on warnings. Override the accent with any hue via `accentColor` /
// `/accent <hex>` — the wordmark sweep follows it.
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
  taskActive: "#70cbf4",
  taskPending: "#e6e6e6",
  accent: "#70cbf4",
  // Blue 300 chrome accent: panel titles, the `❯` user marker + gutter, active
  // task/step, the selected menu row, and the caret. Borders stay neutral grey.
  // Override with a single hue via accentColor / `/accent <hex>`.
  primary: "#70cbf4",
  border: "#34343a",
  muted: "#8a8a92",
  background: "#000000",
  panel: "#161618",
  elevated: "#1e1e22",
  selBg: "#22333d",
  selFg: "#e6e6e6",
  addBg: "#15231a",
  delBg: "#26171c",
  gutter: "#3f5766",
  heading: "#70cbf4",
  code: "#9cdcfe",
  // A calm, distinct 6-hue ramp for charts/pies/sources on black: blue, green,
  // violet, amber, rose, teal — spaced around the wheel so adjacent series never
  // read as the same color, all bright enough to pop on the black backdrop.
  series: ["#70cbf4", "#9ece6a", "#bb9af7", "#e0af68", "#f7768e", "#2ac3de"],
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
  background: "#f6f7f9",
  panel: "#eef1f8",
  elevated: "#e3e8f3",
  selBg: "#d3dcef",
  selFg: "#1a2540",
  addBg: "#e4f0e0",
  delBg: "#f6e0e6",
  gutter: "#9aa7b5",
  heading: "#2959aa",
  code: "#0f5e78",
  // Deeper, saturated hues that stay legible on the light backdrop.
  series: ["#2959aa", "#385f0d", "#5a3e8e", "#8f5e15", "#a1113b", "#0f7b9c"],
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
  background: "#000000",
  panel: "#161616",
  elevated: "#242424",
  selBg: "#343434",
  selFg: "#ffffff",
  addBg: "#003000",
  delBg: "#3a0000",
  gutter: "#7fa8c0",
  heading: "#00d7ff",
  code: "#87e5ff",
  // Maximum-separation bright hues for the high-contrast theme.
  series: ["#00d7ff", "#5fff00", "#ff87ff", "#ffd700", "#ff3b3b", "#00ffaf"],
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
  background: "#0a0a0a",
  panel: "#141414",
  elevated: "#1e1e1e",
  selBg: "#2a2a2a",
  selFg: "#eeeeee",
  addBg: "#20303b",
  delBg: "#37222c",
  gutter: "#544c44",
  heading: "#fab283",
  code: "#56b6c2",
  // Peach-forward ramp echoing the opencode signature, kept distinct per hue.
  series: ["#fab283", "#7fd88f", "#9d7cd8", "#5c9cf5", "#c53b53", "#4fd6be"],
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
