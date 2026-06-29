/**
 * The braille "thinking" spinner, ported from opencode. A monotonically
 * increasing tick selects the frame, so the OpenTUI app can drive it from a
 * single interval-incremented signal and the logic stays trivially testable.
 */

/** Ten-frame braille spinner (opencode's general-purpose working indicator). */
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** Frame for a given tick. Negative ticks wrap correctly. */
export function spinnerFrame(tick: number): string {
  const n = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((tick % n) + n) % n] as string;
}

/** "Working… 3.2s" style label; omits the time until it's worth showing. */
export function workingLabel(elapsedMs: number): string {
  if (elapsedMs < 100) return "Working…";
  return `Working… ${(elapsedMs / 1000).toFixed(1)}s`;
}
