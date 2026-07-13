/**
 * Canonical UI glyphs, shared by the OpenTUI app (`app.tsx`) and the headless
 * renderer (`headless.ts`) so the two surfaces never drift. The README screenshot
 * generator renders the real `App`, so it picks these up automatically.
 *
 * Design system: one calm set across splash / transcript / status. Prefer
 * widely-supported glyphs (avoid rare emoji that mojibake on Windows Terminal).
 */
export const GLYPH = {
  /** Tool call. */
  tool: "⚒",
  /** File written/edited. */
  file: "✎",
  /** Tool result / nested detail. */
  result: "↳",
  /** Backlog (queued type-ahead). */
  queue: "↳",
  /** Subagent started / finished. */
  subagentIn: "⤷",
  subagentOut: "⤶",
  /** Permission request. */
  warn: "⚠",
  /** Checkpoint restored. */
  revert: "⟲",
  /** Verify / check passed. */
  check: "✓",
  /** Loop tick / stop. */
  loopTick: "↻",
  loopStop: "■",
  /** Brand / session mark (sidebar + compact splash). */
  brand: "◆",
  /** Thinking / reasoning. */
  think: "✻",
  /** Collapsed / expandable chevrons. */
  fold: "▸",
  unfold: "▾",
  /** Mode / density separator in status. */
  sep: "·",
} as const;
