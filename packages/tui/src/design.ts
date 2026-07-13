/**
 * Presentation design system for the interactive TUI.
 *
 * Pure helpers only — no OpenTUI/Solid deps. The app imports these for empty-state
 * copy, status chrome, density badges, and context-meter glyphs so the redesign
 * stays unit-testable and the engine contracts stay untouched.
 */

import type { TranscriptDensity } from "./density.ts";
import type { UiMode } from "./modes.ts";
import { hexToHsv } from "./gradient.ts";

/** Short density chip for the under-input status (quiet only when not normal). */
export function densityChip(d: TranscriptDensity): string {
  switch (d) {
    case "quiet":
      return "quiet";
    case "verbose":
      return "verbose";
    default:
      return "";
  }
}

/**
 * Compact context meter for the status strip.
 * Empty under 1%; otherwise a 4-cell bar + percent so fill is glanceable.
 * At ≥80% the bar still renders (color is applied by the caller).
 */
export function contextMeter(pct: number): string {
  if (pct < 1) return "";
  const filled = Math.min(4, Math.max(0, Math.round((pct / 100) * 4)));
  const bar = "▮".repeat(filled) + "▯".repeat(4 - filled);
  return `${bar} ${pct}%`;
}

/** Legacy `ctx N%` form kept for callers that want the plain label. */
export function contextLabel(pct: number): string {
  if (pct < 1) return "";
  return `ctx ${pct}%`;
}

/**
 * Hue for the wordmark gradient / compact logo.
 * Explicit `/accent` wins; otherwise chrome `primary` (white by default — no
 * purple fallback). Themed palettes with a saturated primary keep their brand.
 */
export function wordmarkHue(opts: {
  accent?: string;
  primary: string;
  /** @deprecated Ignored — kept for call-site compatibility. */
  heading?: string;
}): string {
  const accent = (opts.accent ?? "").trim();
  if (accent) return accent;
  return opts.primary;
}

/** Whether a hex is near-achromatic (white/gray chrome). */
export function isNearNeutral(hex: string, floor = 0.12): boolean {
  try {
    return hexToHsv(hex).s < floor;
  } catch {
    return false;
  }
}

/** Interrupt affordance on the working line (always lowercased for scannability). */
export const INTERRUPT_HINT = "esc to interrupt";

/** Working line with interrupt: `Working… 3.2s  ·  esc to interrupt`. */
export function workingLineWithInterrupt(
  elapsedMs: number,
  density: TranscriptDensity = "normal",
): string {
  return `${workingStatusLabel(elapsedMs, density)}  ·  ${INTERRUPT_HINT}`;
}

/** One-line mode description for status / help surfaces. */
export function modeHint(mode: UiMode): string {
  switch (mode) {
    case "plan":
      return "read-only planning";
    case "execute":
      return "tools ask before running";
    case "yolo":
      return "tools run without prompts";
  }
}

/**
 * Permission card title — scannable hierarchy.
 * Keeps "Permission" + tool name so smokes and muscle memory stay intact.
 */
export function permissionTitle(toolName: string, queueDepth: number): string {
  const q = queueDepth > 1 ? ` · 1/${queueDepth}` : "";
  return `Permission required · ${toolName}${q}`;
}

/** Plan card title — fixed string so layout smokes can anchor on it. */
export const PLAN_CARD_TITLE = "Plan · review & approve";

/**
 * Working-line copy. Always starts with "Working" so existing smokes pass;
 * density note is optional tail when not normal.
 */
export function workingStatusLabel(
  elapsedMs: number,
  density: TranscriptDensity = "normal",
): string {
  const base =
    elapsedMs < 100 ? "Working…" : `Working… ${(elapsedMs / 1000).toFixed(1)}s`;
  const chip = densityChip(density);
  if (!chip) return base;
  return `${base}  ·  ${chip}`;
}

/**
 * Footer key-hint specification (priority bands for fitHintSegs).
 * Jobs append separately via {@link buildFooterHintSegs}.
 */
export function footerHintSpec(): {
  key: string;
  desc: string;
  /** Lower = more important. */
  priority: number;
}[] {
  return [
    { key: "shift+tab", desc: " mode", priority: 0 },
    { key: "/", desc: " commands", priority: 1 },
    { key: "ctrl+d", desc: " density", priority: 2 },
    { key: "click", desc: " expand", priority: 3 },
  ];
}

/** One coloured run for footer / card hints (same shape as `hints.ts` HintSeg). */
export interface FooterHintSeg {
  t: string;
  fg: string;
  priority?: number;
}

/**
 * Assemble under-input key hints: optional running-jobs prefix, then
 * {@link footerHintSpec} rows. Separators go **between** groups only — never
 * double after the jobs prefix (a jobs-trailing ` · ` + loop-leading ` · `
 * used to render as `(/jobs)  ·    ·  shift+tab`).
 */
export function buildFooterHintSegs(opts: {
  runningJobs: number;
  lit: string;
  dim: string;
  notice: string;
}): FooterHintSeg[] {
  const segs: FooterHintSeg[] = [];
  const n = Math.max(0, opts.runningJobs | 0);
  if (n > 0) {
    segs.push(
      { t: `${n} job${n === 1 ? "" : "s"}`, fg: opts.notice, priority: 0 },
      { t: " running ", fg: opts.dim, priority: 0 },
      { t: "(/jobs)", fg: opts.lit, priority: 0 },
    );
  }
  const spec = footerHintSpec();
  for (let i = 0; i < spec.length; i++) {
    const h = spec[i]!;
    // Separator before each hint item when anything already precedes it
    // (jobs prefix and/or earlier tips) — single ` · `, never doubled.
    if (segs.length > 0) {
      segs.push({ t: "  ·  ", fg: opts.dim, priority: h.priority });
    }
    segs.push(
      { t: h.key, fg: opts.lit, priority: h.priority },
      { t: h.desc, fg: opts.dim, priority: h.priority },
    );
  }
  return segs;
}

/**
 * Folded-turn affordance copy — consistent across window fold + in-turn fold.
 */
export function earlierTurnsLabel(count: number, page: number): string {
  const n = Math.max(0, count);
  const load = Math.min(page, n);
  return `▸ ${n} earlier turn${n === 1 ? "" : "s"} · tap to load ${load} more`;
}

export function itemsHiddenLabel(count: number): string {
  const n = Math.max(0, count);
  return `▸ ${n} item${n === 1 ? "" : "s"} hidden · tap to expand`;
}

/** Input placeholder — must contain "Send a message" for smoke. */
export const INPUT_PLACEHOLDER = "Send a message or type / to start";
