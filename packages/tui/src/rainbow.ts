/**
 * Rainbow color helpers — the TUI's accent color language.
 *
 * Deliberately dependency-free (pure HSV→hex math, no `@opentui/core` import) so
 * it runs under `bun test` without the optional native peer dep. The sweep is a
 * curated rainbow — hue 0°(red) → ~285°(violet), at a fixed saturation/value
 * tuned to read vivid-but-clean on the black UI. It backs three things:
 *   • the static wordmark gradient   — color by COLUMN (`rainbowSpans`)
 *   • the animated working spinner    — color by TICK   (`rainbowAt`)
 *   • per-agent / per-step rotation   — color by INDEX  (`rotateHue`)
 * Color is applied to ACCENTS only (glyphs, the wordmark, markers) — never body
 * text — so the effect stays tasteful and output stays readable.
 */

// Red → violet; stop before wrapping back through red so the gradient reads as a
// single clean sweep rather than a full color wheel.
const HUE_START = 0;
const HUE_END = 285;
const SAT = 0.72;
const VAL = 1;

/** HSV (h in degrees, s/v in 0..1) → `#rrggbb`. */
function hsvToHex(h: number, s: number, v: number): string {
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

/** A clean rainbow color at position `t` ∈ [0,1] (values outside wrap). */
export function rainbowAt(t: number): string {
  const u = ((t % 1) + 1) % 1;
  return hsvToHex(HUE_START + (HUE_END - HUE_START) * u, SAT, VAL);
}

/**
 * Per-character runs colored by COLUMN position, for the wordmark gradient.
 * Column `i` gets the same hue in every row, so a multi-row block reads as one
 * smooth left-to-right gradient (clean vertical bands), not per-letter confetti.
 */
export function rainbowSpans(text: string, totalCols: number): { ch: string; fg: string }[] {
  const cols = Math.max(1, totalCols);
  return [...text].map((ch, i) => ({ ch, fg: rainbowAt(i / cols) }));
}

/**
 * A stable, distinct hue for item `index` — per-agent / per-step rotation. Cycles
 * every `total` items; the default spacing keeps adjacent items visually distinct
 * (so two concurrent subagents, or two sequential tool steps, never collide).
 */
export function rotateHue(index: number, total = 7): string {
  const n = Math.max(1, total);
  return rainbowAt((((index % n) + n) % n) / n);
}
