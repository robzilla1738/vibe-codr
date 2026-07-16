/**
 * Width-aware key-hint rows for plan/permission/footer chrome.
 *
 * Terminal cards used to append every segment and hard-clip mid-token ("scro").
 * Fit by priority: keep highest-priority groups that still fit the budget;
 * drop whole low-priority groups (never a half word).
 */

import { displayWidth } from "./markdown-blocks.ts";

export interface HintSeg {
  t: string;
  fg: string;
  /** Lower = more important; default 0. Groups with the same priority are kept/dropped together. */
  priority?: number;
}

/**
 * Fit segments into `maxWidth` columns. Segments share a priority band: if a
 * band doesn't fit, the entire band is dropped (lowest-priority first). Within
 * a kept band, segments are concatenated as given.
 *
 * Returns the kept segments (without the `priority` field requirement on callers
 * that only need `t`/`fg`).
 */
export function fitHintSegs(segs: HintSeg[], maxWidth: number): HintSeg[] {
  if (maxWidth <= 0) return [];
  if (segs.length === 0) return [];

  const widthOf = (list: HintSeg[]) => list.reduce((n, s) => n + displayWidth(s.t), 0);
  if (widthOf(segs) <= maxWidth) return segs;

  // Distinct priorities, high → low importance for dropping (drop largest number first).
  const priorities = [...new Set(segs.map((s) => s.priority ?? 0))].sort((a, b) => b - a);
  let keep = new Set(priorities);

  for (const p of priorities) {
    // Never drop the top (most important) band entirely if anything remains.
    if (keep.size <= 1) break;
    const candidate = new Set(keep);
    candidate.delete(p);
    const next = segs.filter((s) => candidate.has(s.priority ?? 0));
    if (next.length === 0) continue;
    keep = candidate;
    if (widthOf(next) <= maxWidth) return next;
  }

  // Still too wide: return the highest-priority band only (may still overflow on
  // extremely narrow panes — caller should also wrap with flexWrap when needed).
  const top = Math.min(...keep);
  return segs.filter((s) => (s.priority ?? 0) === top);
}

/** Total display width of a segment list. */
export function hintSegsWidth(segs: readonly HintSeg[]): number {
  return segs.reduce((n, s) => n + displayWidth(s.t), 0);
}
