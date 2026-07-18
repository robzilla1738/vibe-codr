// Token-first design system for the mobile renderer — a faithful port of the
// Electron shell's `:root` CSS variables and `applyPalette` derivation
// (src/renderer/styles.css + src/renderer/theme/applyPalette.ts). One source of
// truth for the visual language across desktop and mobile.
import type { Palette } from "@shared/themes";
import { paletteColorScheme, resolveChromeAccent } from "@shared/theme-scheme";
import { fade, mixOklab, withAlpha } from "./color";

/** Static, theme-independent design tokens (the non-color `:root` vars). */
export const staticTokens = {
  // type scale
  textDisplay: 32,
  textDisplaySm: 20,
  textHeading: 18,
  textTitle: 16,
  textProse: 15,
  textUi: 13,
  textLabel: 12,
  textCaption: 11,
  textMicro: 10,
  textCode: 12.5,
  weightRegular: "400",
  weightUi: "450",
  weightMedium: "500",
  weightSemi: "600",
  trackingUi: -0.01,
  trackingTight: -0.02,
  leadingTight: 1.2,
  leadingUi: 1.4,
  leadingProse: 1.65,
  leadingCode: 1.6,
  // spacing
  s2xs: 4,
  sXs: 8,
  sSm: 12,
  sBase: 16,
  sMd: 24,
  sLg: 32,
  sXl: 48,
  s2xl: 64,
  s3xl: 96,
  // radius
  radiusXs: 4,
  radiusSm: 8,
  radiusMd: 10,
  radius: 12,
  radiusLg: 12,
  radiusXl: 16,
  radiusPill: 999,
  // motion
  durMicro: 80,
  durFast: 120,
  durStandard: 200,
  durModerate: 280,
  durThinking: 1800,
  durPress: 60,
  pressOffset: 1,
  easeEnter: [0, 0, 0.2, 1] as const,
  easeExit: [0.4, 0, 1, 1] as const,
  easeStandard: [0.4, 0, 0.2, 1] as const,
  // layout measures (parity: content ~130ch, sidebar ~42ch, 40rem shared measure)
  topbarH: 52,
  railChromeH: 40,
  railTitleH: 48,
  projectRailW: 280,
  railIconSize: 16,
  workspaceLaneW: 300,
  workspaceDockW: 220,
  activityRailW: 300,
  changesRailW: 560,
  composerInputMin: 44,
  composerInputMax: 320,
  composerChipH: 26,
} as const;

export type ColorTokens = {
  bg: string; panel: string; elevated: string; surface: string; surfaceSubtle: string;
  border: string; borderSoft: string; borderStrong: string; borderActive: string;
  muted: string; assistant: string; textSecondary: string; textSubtle: string;
  primary: string; accent: string; user: string; tool: string; notice: string;
  plan: string; subagent: string; add: string; del: string; addBg: string; delBg: string;
  diffAdd: string; diffDel: string; diffAddBg: string; diffDelBg: string;
  gutter: string; heading: string; code: string; ctx: string;
  selBg: string; selFg: string; ring: string; focus: string; mode: string;
  taskDone: string; taskActive: string; taskPending: string; taskFailed: string; taskSkipped: string;
  overlay: string; cardBg: string; drawerBg: string; bubbleUserBg: string; bubbleUserBorder: string;
  navActiveBg: string; edgeLit: string; shadowInk: string;
  scheme: "light" | "dark";
};

export type Theme = { name: string; colors: ColorTokens; accentOverride?: string };

/** Port of applyPalette(): palette + accent → full color token set (no DOM). */
export function buildColorTokens(
  palette: Palette,
  accentOverride: string | undefined,
  themeName: string | undefined,
): ColorTokens {
  const scheme = paletteColorScheme(palette);
  const ui = scheme === "light"
    ? {
        ...palette,
        assistant: "#20242e",
        muted: "#68707a",
        heading: "#20242e",
        border: "#d5d8df",
        background: "#f8f8f7",
        panel: "#eff0f2",
        elevated: "#ffffff",
        ctx: "#677184",
        taskDone: "#7b8494",
      }
    : palette;
  const chrome = resolveChromeAccent(palette, accentOverride);
  const diff = themeName === "contrast"
    ? { add: "#5fff00", del: "#ff3b3b", addBg: "#003000", delBg: "#3a0000" }
    : scheme === "light"
      ? { add: "#087a3b", del: "#c92a2a", addBg: "#dff5e8", delBg: "#fde5e5" }
      : { add: "#00d26a", del: "#ff4d4f", addBg: "#123522", delBg: "#3b1d22" };

  const bg = ui.background;
  const panel = ui.panel;
  const elevated = ui.elevated;
  const border = ui.border;

  return {
    bg,
    panel,
    elevated,
    surface: elevated,
    surfaceSubtle: mixOklab(elevated, 0.72, bg),
    border,
    borderSoft: mixOklab(border, 0.7, "transparent"),
    borderStrong: border,
    borderActive: mixOklab(chrome.ring, 0.4, border),
    muted: ui.muted,
    assistant: ui.assistant,
    textSecondary: mixOklab(ui.assistant, 0.62, ui.muted),
    textSubtle: mixOklab(ui.muted, 0.88, ui.assistant),
    primary: chrome.primary,
    accent: chrome.accent,
    user: palette.user,
    tool: palette.tool,
    notice: palette.notice,
    plan: palette.plan,
    subagent: palette.subagent,
    add: palette.add,
    del: palette.del,
    addBg: palette.addBg,
    delBg: palette.delBg,
    diffAdd: diff.add,
    diffDel: diff.del,
    diffAddBg: diff.addBg,
    diffDelBg: diff.delBg,
    gutter: palette.gutter,
    heading: scheme === "light" ? ui.heading : chrome.heading,
    code: palette.code,
    ctx: ui.ctx,
    selBg: chrome.selBg,
    selFg: chrome.selFg,
    ring: chrome.ring,
    focus: chrome.focus,
    mode: chrome.mode,
    taskDone: ui.taskDone,
    taskActive: palette.taskActive,
    taskPending: palette.taskPending,
    taskFailed: palette.del,
    taskSkipped: ui.muted,
    overlay: mixOklab(elevated, 0.94, panel),
    cardBg: mixOklab(mixOklab(elevated, 0.72, bg), 0.58, bg),
    drawerBg: elevated,
    bubbleUserBg: mixOklab(elevated, 0.98, panel),
    bubbleUserBorder: mixOklab(border, 0.26, "transparent"),
    navActiveBg: mixOklab(elevated, 0.64, "transparent"),
    edgeLit: scheme === "light" ? "#ffffff" : "#ffffff",
    shadowInk: scheme === "light" ? "#000000" : "#000000",
    scheme,
  };
}

export { fade, mixOklab, withAlpha };

// Elevation shadows — ports of the desktop --shadow-modal/menu/float (oklab ink
// at alpha). RN shadow dicts approximate the two-layer CSS shadows.
export function shadowModal(colors: ColorTokens) {
  return { shadowColor: colors.shadowInk, shadowOpacity: 0.46, shadowRadius: 40, shadowOffset: { width: 0, height: 24 }, elevation: 24 };
}
export function shadowMenu(colors: ColorTokens) {
  return { shadowColor: colors.shadowInk, shadowOpacity: 0.34, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 12 };
}
export function shadowFloat(colors: ColorTokens) {
  return { shadowColor: colors.shadowInk, shadowOpacity: 0.32, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8 };
}
export function shadowComposer(colors: ColorTokens) {
  return { shadowColor: colors.shadowInk, shadowOpacity: colors.scheme === "light" ? 0.09 : 0.18, shadowRadius: 22, shadowOffset: { width: 0, height: 8 }, elevation: 6 };
}
