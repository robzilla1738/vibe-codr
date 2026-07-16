/**
 * Named layout breakpoints for the Electron shell.
 *
 * CSS `@media (max-width: …)` values for dock/laptop/tablet/compact/narrow live in
 * `styles.css` and must stay in sync with those pixel numbers. `wide` is JS-only
 * (layout comfort when project rail + column + Session panel fit) — there is no
 * matching `@media (min-width: 1280px)` rule.
 *
 * Measure notes (AGENTS): content column ~130ch, Session panel ~42ch;
 * `wide` is when project rail + column + Session panel fit without crushing.
 */
export const BREAKPOINTS = {
  /** Comfortable width for project rail + column + Session panel. */
  wide: 1280,
  /** Topbar action labels compress. */
  laptop: 1100,
  /** Workspace dock switches to compact icon navigation. */
  dock: 960,
  /** Project rail becomes a start-edge overlay drawer. */
  tablet: 900,
  /** Session panel becomes an end-edge overlay drawer. */
  compact: 720,
  /** Phone-narrow chrome densifies (model chip stays, truncated). */
  narrow: 640,
} as const;

export type BreakpointName = keyof typeof BREAKPOINTS;

/** True when the viewport is strictly below the named breakpoint. */
export function belowBreakpoint(
  name: BreakpointName,
  width = typeof window !== "undefined" ? window.innerWidth : BREAKPOINTS.wide,
): boolean {
  return width < BREAKPOINTS[name];
}

/** True when the viewport is at least the named breakpoint. */
export function atBreakpoint(
  name: BreakpointName,
  width = typeof window !== "undefined" ? window.innerWidth : BREAKPOINTS.wide,
): boolean {
  return width >= BREAKPOINTS[name];
}
