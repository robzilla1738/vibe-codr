/**
 * Single-hue accent gradient — the TUI's calm color language.
 *
 * Deliberately dependency-free (pure HSV↔hex math, no `@opentui/core` import) so
 * it runs under `bun test` without the optional native peer dep. It replaces the
 * old full-spectrum rainbow with a tasteful **single-hue ramp**: one accent hue
 * (Blue 300 by default) swept from a light tint to a deep shade. The hue is
 * derived from whatever accent is active, so a `/accent <hex>` override recolors
 * the wordmark coherently rather than fighting a hardcoded blue.
 *
 * It backs one thing: the static wordmark gradient (color by COLUMN, `brandSpans`).
 * The spinner and per-step/subagent gutters are now flat palette tones (no sweep).
 * Color stays on ACCENTS only (the wordmark) — never body text.
 */

/** Blue 300 — the default accent hue the ramp sweeps around. */
export const BLUE_300 = "#70cbf4";

// The ramp holds the accent's hue fixed and sweeps saturation up / value down, so
// t=0 reads as a light airy tint and t=1 as a deep saturated shade — one clean
// blue band, not a color wheel. Multipliers tuned so Blue 300 sweeps
// ~#8fd6f7 (light) → #70cbf4 → deep #2b7fb8, matching the approved wordmark.
const LIGHT_SAT = 0.78;
const LIGHT_VAL = 1.02;
const DEEP_SAT = 1.42;
const DEEP_VAL = 0.75;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** HSV (h in degrees, s/v in 0..1) → `#rrggbb`. */
export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const hp = ((((h % 360) + 360) % 360) / 60);
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  const to = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** `#rgb` / `#rrggbb` → HSV (h in degrees 0..360, s/v in 0..1). */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  let x = hex.trim().replace(/^#/, "");
  if (x.length === 3) x = [...x].map((c) => c + c).join("");
  const r = parseInt(x.slice(0, 2), 16) / 255;
  const g = parseInt(x.slice(2, 4), 16) / 255;
  const b = parseInt(x.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

/**
 * The accent color at ramp position `t` ∈ [0,1]: t=0 the light tint, t=1 the deep
 * shade, holding `hue`'s base hue fixed. Values outside [0,1] clamp. Defaults to
 * Blue 300 but takes the live accent hex so the sweep follows `/accent`.
 */
export function brandRamp(t: number, hue: string = BLUE_300): string {
  const u = clamp01(t);
  const { h, s, v } = hexToHsv(hue);
  const sLight = clamp01(s * LIGHT_SAT);
  const sDeep = clamp01(s * DEEP_SAT);
  const vLight = clamp01(v * LIGHT_VAL);
  const vDeep = clamp01(v * DEEP_VAL);
  return hsvToHex(h, sLight + (sDeep - sLight) * u, vLight + (vDeep - vLight) * u);
}

/**
 * Per-character runs colored by COLUMN position, for the wordmark gradient.
 * Column `i` gets the same ramp position in every row, so a multi-row block reads
 * as one smooth left→right sweep (clean vertical bands), not per-letter confetti.
 */
export function brandSpans(
  text: string,
  totalCols: number,
  hue: string = BLUE_300,
): { ch: string; fg: string }[] {
  const cols = Math.max(1, totalCols);
  return [...text].map((ch, i) => ({ ch, fg: brandRamp(i / cols, hue) }));
}
