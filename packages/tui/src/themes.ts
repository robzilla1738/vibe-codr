/**
 * UI themes for the OpenTUI app — named palettes selectable with `/theme`.
 * Each palette maps the app's semantic line kinds to hex colors. The headless
 * REPL uses 16-color ANSI (see `ansi.ts`) and is theme-agnostic.
 *
 * The selectable theme NAMES and the named accent presets are pure serializable
 * data the ENGINE also needs (to validate `/theme` + resolve `/accent`), so they
 * live in `@vibe/shared` (`THEME_NAMES`/`ACCENT_PRESETS`) — one source across the
 * core/TUI boundary, no hand-synced copies. This file owns only the render-side
 * PALETTES; `themes.test.ts` asserts `THEMES` covers exactly `THEME_NAMES`.
 */
import { ACCENT_NAMES, ACCENT_PRESETS, THEME_NAMES } from "@vibe/shared";

export { ACCENT_NAMES, ACCENT_PRESETS, THEME_NAMES };

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

/** Vibe dark palette (the default) — warm peach chrome on near-black surfaces. */
const DEFAULT: Palette = {
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
  series: ["#fab283", "#7fd88f", "#9d7cd8", "#5c9cf5", "#c53b53", "#4fd6be"],
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

// ── Ported classics ───────────────────────────────────────────────────────────
// Each is mapped from its canonical palette (via opencode's theme set) onto our
// semantic tokens, hand-tuned for this app's design language: the theme's OWN
// background, raised panel/elevated surfaces, a quiet border, one signature
// primary reserved for markers, and a 6-hue series ramp for the data views.

/** Tokyo Night (moon) — indigo night backdrop, blue primary, violet headings. */
const TOKYONIGHT: Palette = {
  user: "#c8d3f5",
  assistant: "#c8d3f5",
  tool: "#82aaff",
  notice: "#ff966c",
  plan: "#c099ff",
  subagent: "#c3e88d",
  add: "#c3e88d",
  del: "#ff757f",
  ctx: "#828bb8",
  taskDone: "#545c7e",
  taskActive: "#82aaff",
  taskPending: "#c8d3f5",
  accent: "#82aaff",
  primary: "#82aaff",
  border: "#3b4261",
  muted: "#828bb8",
  background: "#1a1b26",
  panel: "#1e2030",
  elevated: "#222436",
  selBg: "#2f3450",
  selFg: "#c8d3f5",
  addBg: "#20303b",
  delBg: "#37222c",
  gutter: "#3b4261",
  heading: "#c099ff",
  code: "#c3e88d",
  series: ["#82aaff", "#c3e88d", "#c099ff", "#ff966c", "#ff757f", "#4fd6be"],
};

/** Catppuccin (mocha) — soft pastels on a deep mauve-tinted base. */
const CATPPUCCIN: Palette = {
  user: "#cdd6f4",
  assistant: "#cdd6f4",
  tool: "#94e2d5",
  notice: "#f9e2af",
  plan: "#cba6f7",
  subagent: "#a6e3a1",
  add: "#a6e3a1",
  del: "#f38ba8",
  ctx: "#9399b2",
  taskDone: "#6c7086",
  taskActive: "#89b4fa",
  taskPending: "#cdd6f4",
  accent: "#89b4fa",
  primary: "#89b4fa",
  border: "#313244",
  muted: "#9399b2",
  background: "#1e1e2e",
  panel: "#27273a",
  elevated: "#313244",
  selBg: "#45475a",
  selFg: "#cdd6f4",
  addBg: "#24312b",
  delBg: "#3c2a32",
  gutter: "#585b70",
  heading: "#cba6f7",
  code: "#a6e3a1",
  series: ["#89b4fa", "#a6e3a1", "#cba6f7", "#f9e2af", "#f38ba8", "#94e2d5"],
};

/** Gruvbox (dark) — warm retro groove, aqua primary, honeyed code. */
const GRUVBOX: Palette = {
  user: "#ebdbb2",
  assistant: "#ebdbb2",
  tool: "#83a598",
  notice: "#fe8019",
  plan: "#d3869b",
  subagent: "#b8bb26",
  add: "#b8bb26",
  del: "#fb4934",
  ctx: "#928374",
  taskDone: "#7c6f64",
  taskActive: "#83a598",
  taskPending: "#ebdbb2",
  accent: "#83a598",
  primary: "#83a598",
  border: "#504945",
  muted: "#928374",
  background: "#282828",
  panel: "#32302f",
  elevated: "#3c3836",
  selBg: "#504945",
  selFg: "#ebdbb2",
  addBg: "#283018",
  delBg: "#321a17",
  gutter: "#665c54",
  heading: "#83a598",
  code: "#fabd2f",
  series: ["#83a598", "#b8bb26", "#d3869b", "#fe8019", "#fb4934", "#8ec07c"],
};

/** Nord — arctic bluish greys, frost-cyan primary. */
const NORD: Palette = {
  user: "#eceff4",
  assistant: "#eceff4",
  tool: "#88c0d0",
  notice: "#d08770",
  plan: "#b48ead",
  subagent: "#a3be8c",
  add: "#a3be8c",
  del: "#bf616a",
  ctx: "#8b95a7",
  taskDone: "#616e88",
  taskActive: "#88c0d0",
  taskPending: "#eceff4",
  accent: "#88c0d0",
  primary: "#88c0d0",
  border: "#434c5e",
  muted: "#8b95a7",
  background: "#2e3440",
  panel: "#3b4252",
  elevated: "#434c5e",
  selBg: "#4c566a",
  selFg: "#eceff4",
  addBg: "#323e32",
  delBg: "#3e2f34",
  gutter: "#4c566a",
  heading: "#81a1c1",
  code: "#a3be8c",
  series: ["#88c0d0", "#a3be8c", "#b48ead", "#d08770", "#bf616a", "#5e81ac"],
};

/** One Dark (Atom) — the classic editor dark, azure primary. */
const ONE_DARK: Palette = {
  user: "#abb2bf",
  assistant: "#abb2bf",
  tool: "#56b6c2",
  notice: "#e5c07b",
  plan: "#c678dd",
  subagent: "#98c379",
  add: "#98c379",
  del: "#e06c75",
  ctx: "#5c6370",
  taskDone: "#4b5263",
  taskActive: "#61afef",
  taskPending: "#abb2bf",
  accent: "#61afef",
  primary: "#61afef",
  border: "#3e4451",
  muted: "#5c6370",
  background: "#282c34",
  panel: "#2c313a",
  elevated: "#333842",
  selBg: "#3e4451",
  selFg: "#abb2bf",
  addBg: "#2c382b",
  delBg: "#3a2d2f",
  gutter: "#4b5263",
  heading: "#c678dd",
  code: "#98c379",
  series: ["#61afef", "#98c379", "#c678dd", "#e5c07b", "#e06c75", "#56b6c2"],
};

/** Dracula — the purple-fanged classic. */
const DRACULA: Palette = {
  user: "#f8f8f2",
  assistant: "#f8f8f2",
  tool: "#8be9fd",
  notice: "#ffb86c",
  plan: "#bd93f9",
  subagent: "#50fa7b",
  add: "#50fa7b",
  del: "#ff5555",
  ctx: "#6272a4",
  taskDone: "#565b73",
  taskActive: "#8be9fd",
  taskPending: "#f8f8f2",
  accent: "#bd93f9",
  primary: "#bd93f9",
  border: "#44475a",
  muted: "#6272a4",
  background: "#282a36",
  panel: "#313341",
  elevated: "#3a3c4e",
  selBg: "#44475a",
  selFg: "#f8f8f2",
  addBg: "#233828",
  delBg: "#3a2228",
  gutter: "#495071",
  heading: "#bd93f9",
  code: "#50fa7b",
  series: ["#bd93f9", "#50fa7b", "#ff79c6", "#ffb86c", "#ff5555", "#8be9fd"],
};

/** Rosé Pine — muted rose-and-pine soho vibes, rose primary. */
const ROSEPINE: Palette = {
  user: "#e0def4",
  assistant: "#e0def4",
  tool: "#9ccfd8",
  notice: "#f6c177",
  plan: "#c4a7e7",
  subagent: "#3e8fb0",
  add: "#3e8fb0",
  del: "#eb6f92",
  ctx: "#6e6a86",
  taskDone: "#524f67",
  taskActive: "#9ccfd8",
  taskPending: "#e0def4",
  accent: "#ebbcba",
  primary: "#ebbcba",
  border: "#403d52",
  muted: "#6e6a86",
  background: "#191724",
  panel: "#1f1d2e",
  elevated: "#26233a",
  selBg: "#403d52",
  selFg: "#e0def4",
  addBg: "#1f2d3a",
  delBg: "#3a1f2d",
  gutter: "#56526e",
  heading: "#c4a7e7",
  code: "#f6c177",
  series: ["#ebbcba", "#9ccfd8", "#c4a7e7", "#f6c177", "#eb6f92", "#3e8fb0"],
};

/** Kanagawa — ink-wave blues on sumi paper. */
const KANAGAWA: Palette = {
  user: "#dcd7ba",
  assistant: "#dcd7ba",
  tool: "#7e9cd8",
  notice: "#d7a657",
  plan: "#957fb8",
  subagent: "#98bb6c",
  add: "#98bb6c",
  del: "#e46876",
  ctx: "#727169",
  taskDone: "#54546d",
  taskActive: "#7e9cd8",
  taskPending: "#dcd7ba",
  accent: "#7e9cd8",
  primary: "#7e9cd8",
  border: "#363646",
  muted: "#727169",
  background: "#1f1f28",
  panel: "#2a2a37",
  elevated: "#363646",
  selBg: "#2d4f67",
  selFg: "#dcd7ba",
  addBg: "#252e25",
  delBg: "#362020",
  gutter: "#54546d",
  heading: "#957fb8",
  code: "#98bb6c",
  series: ["#7e9cd8", "#98bb6c", "#957fb8", "#d7a657", "#e46876", "#6a9589"],
};

/** Everforest — comfortable green forest on warm grey. */
const EVERFOREST: Palette = {
  user: "#d3c6aa",
  assistant: "#d3c6aa",
  tool: "#7fbbb3",
  notice: "#e69875",
  plan: "#d699b6",
  subagent: "#a7c080",
  add: "#a7c080",
  del: "#e67e80",
  ctx: "#7a8478",
  taskDone: "#56635f",
  taskActive: "#7fbbb3",
  taskPending: "#d3c6aa",
  accent: "#a7c080",
  primary: "#a7c080",
  border: "#475258",
  muted: "#7a8478",
  background: "#2d353b",
  panel: "#333c43",
  elevated: "#3d484d",
  selBg: "#475258",
  selFg: "#d3c6aa",
  addBg: "#313d33",
  delBg: "#3a2b2e",
  gutter: "#56635f",
  heading: "#d699b6",
  code: "#83c092",
  series: ["#a7c080", "#7fbbb3", "#d699b6", "#e69875", "#e67e80", "#83c092"],
};

/** Flexoki (dark) — inky paper contrast with a BURNT-ORANGE primary. */
const FLEXOKI: Palette = {
  user: "#cecdc3",
  assistant: "#cecdc3",
  tool: "#3aa99f",
  notice: "#d0a215",
  plan: "#8b7ec8",
  subagent: "#879a39",
  add: "#879a39",
  del: "#d14d41",
  ctx: "#6f6e69",
  taskDone: "#575653",
  taskActive: "#da702c",
  taskPending: "#cecdc3",
  accent: "#da702c",
  primary: "#da702c",
  border: "#343331",
  muted: "#6f6e69",
  background: "#100f0f",
  panel: "#1c1b1a",
  elevated: "#282726",
  selBg: "#343331",
  selFg: "#cecdc3",
  addBg: "#202614",
  delBg: "#2c1614",
  gutter: "#575653",
  heading: "#da702c",
  code: "#3aa99f",
  series: ["#da702c", "#879a39", "#8b7ec8", "#d0a215", "#d14d41", "#3aa99f"],
};

/** Vesper — near-black minimalism with a PEACH primary and mint code. */
const VESPER: Palette = {
  user: "#ffffff",
  assistant: "#ffffff",
  tool: "#99ffe4",
  notice: "#ffc799",
  plan: "#ffc799",
  subagent: "#99ffe4",
  add: "#99ffe4",
  del: "#ff8080",
  ctx: "#a0a0a0",
  taskDone: "#666666",
  taskActive: "#ffc799",
  taskPending: "#ffffff",
  accent: "#ffc799",
  primary: "#ffc799",
  border: "#282828",
  muted: "#a0a0a0",
  background: "#101010",
  panel: "#161616",
  elevated: "#1e1e1e",
  selBg: "#2a2a2a",
  selFg: "#ffffff",
  addBg: "#0d2818",
  delBg: "#281a1a",
  gutter: "#505050",
  heading: "#ffc799",
  code: "#99ffe4",
  series: ["#ffc799", "#99ffe4", "#ff8080", "#e6e6e6", "#a0a0a0", "#7dcfff"],
};

export const THEMES: Record<string, Palette> = {
  default: DEFAULT,
  dark: DEFAULT,
  light: LIGHT,
  contrast: CONTRAST,
  tokyonight: TOKYONIGHT,
  catppuccin: CATPPUCCIN,
  gruvbox: GRUVBOX,
  nord: NORD,
  "one-dark": ONE_DARK,
  dracula: DRACULA,
  rosepine: ROSEPINE,
  kanagawa: KANAGAWA,
  everforest: EVERFOREST,
  flexoki: FLEXOKI,
  vesper: VESPER,
};

/** The preset name for a hex accent (case-insensitive), or undefined. */
export function accentNameOf(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const target = hex.toLowerCase();
  return ACCENT_NAMES.find((n) => ACCENT_PRESETS[n] === target);
}

/** Resolve a theme name to its palette, falling back to the default. */
export function getTheme(name: string | undefined): Palette {
  return (name && THEMES[name]) || DEFAULT;
}

/** Whether `name` is a known theme. */
export function isKnownTheme(name: string): boolean {
  return name in THEMES;
}
