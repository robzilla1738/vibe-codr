/**
 * Shared layout tokens for the OpenTUI app. The app's bordered info panels
 * (plan, tasks, subagents, queue) repeat the exact same static chrome — border,
 * column flow, vertical rhythm, horizontal padding. Centralizing it here means
 * one lever tunes every panel's spacing/border at once (instead of ad-hoc inline
 * values drifting apart), and each call site keeps only its reactive props
 * (borderColor, title, titleColor).
 */

/** Static chrome shared by the app's bordered info panels. Spread onto a `<box>`;
 * add `borderColor` / `title` / `titleColor` at the call site. */
export const PANEL = {
  border: true,
  flexDirection: "column",
  flexShrink: 0,
  marginTop: 1,
  paddingLeft: 1,
  paddingRight: 1,
} as const;
