/**
 * Canonical UI glyphs, shared by the OpenTUI app (`app.tsx`) and the headless
 * renderer (`headless.ts`) so the two surfaces never drift.
 *
 * NOTE: `packages/core/scripts/screenshot.ts` lives in `@vibe/core` and must not
 * import from `@vibe/tui`, so it keeps its own literal copies — keep them
 * identical to the values below (it carries a comment pointing here).
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
