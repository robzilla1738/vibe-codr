/**
 * Canonical UI glyphs, shared by the OpenTUI app (`app.tsx`) and the headless
 * renderer (`headless.ts`) so the two surfaces never drift. The README screenshot
 * generator renders the real `App`, so it picks these up automatically.
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
} as const;
