// Faithful JS port of CSS `color-mix(in oklab, <a> <pct>%, <b>)` so the mobile
// theme derives the exact same token colors the Electron shell computes in CSS.
// No approximation: sRGB → linear → OKLab → mix → linear → sRGB → rgba string.

export function parseHex(hex: string): [number, number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) {
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16), a = parseInt(h.slice(6, 8), 16) / 255;
    return [r, g, b, a];
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

function srgbToLin(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function linToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, v));
}

function hexToOklab(hex: string): { L: number; a: number; b: number; alpha: number } | null {
  if (hex.trim().toLowerCase() === "transparent") return { L: 0, a: 0, b: 0, alpha: 0 };
  const p = parseHex(hex);
  if (!p) return null;
  const [r, g, b, alpha] = p;
  const lr = srgbToLin(r / 255), lg = srgbToLin(g / 255), lb = srgbToLin(b / 255);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024610 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    alpha,
  };
}

function oklabToRgba(o: { L: number; a: number; b: number; alpha: number }): string {
  const l_ = o.L + 0.3963377774 * o.a + 0.2158037573 * o.b;
  const m_ = o.L - 0.1055613458 * o.a - 0.0638541728 * o.b;
  const s_ = o.L - 0.0894841775 * o.a - 1.2914855480 * o.b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const r = Math.round(linToSrgb(lr) * 255);
  const g = Math.round(linToSrgb(lg) * 255);
  const b = Math.round(linToSrgb(lb) * 255);
  return o.alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+o.alpha.toFixed(3)})`;
}

/** `color-mix(in oklab, colorA pct%, colorB)`. pct of 100 → A; 0 → B. */
export function mixOklab(colorA: string, pctA: number, colorB: string): string {
  const a = hexToOklab(colorA) ?? hexToOklab("#000000")!;
  const b = hexToOklab(colorB) ?? hexToOklab("#000000")!;
  const t = Math.min(100, Math.max(0, pctA)) / 100;
  return oklabToRgba({
    L: a.L * t + b.L * (1 - t),
    a: a.a * t + b.a * (1 - t),
    b: a.b * t + b.b * (1 - t),
    alpha: a.alpha * t + b.alpha * (1 - t),
  });
}

/** `color-mix(in oklab, color pct%, transparent)` — fade toward transparent. */
export function fade(color: string, pct: number): string {
  return mixOklab(color, pct, "transparent");
}

export function withAlpha(color: string, alpha: number): string {
  const p = parseHex(color);
  if (!p) return color;
  return `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${+alpha.toFixed(3)})`;
}
