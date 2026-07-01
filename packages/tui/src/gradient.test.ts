import { test, expect } from "bun:test";
import { brandRamp, brandSpans, hexToHsv, hsvToHex, BLUE_300 } from "./gradient.ts";

const HEX = /^#[0-9a-f]{6}$/;

test("hexToHsv ∘ hsvToHex round-trips a color within rounding tolerance", () => {
  for (const hex of [BLUE_300, "#8fd6f7", "#2b7fb8", "#ffffff", "#000000", "#425a6b"]) {
    const { h, s, v } = hexToHsv(hex);
    expect(hsvToHex(h, s, v)).toBe(hex);
  }
});

test("hexToHsv accepts 3-digit shorthand", () => {
  expect(hexToHsv("#08f")).toEqual(hexToHsv("#0088ff"));
});

test("brandRamp returns valid hex across the range and clamps out-of-range t", () => {
  for (const t of [0, 0.25, 0.5, 0.75, 1]) expect(brandRamp(t)).toMatch(HEX);
  expect(brandRamp(-1)).toBe(brandRamp(0)); // clamps, no wrap-around seam
  expect(brandRamp(2)).toBe(brandRamp(1));
  expect(brandRamp(0)).not.toBe(brandRamp(1)); // a real sweep
});

test("the ramp stays within one hue band (light tint → deep shade, not a color wheel)", () => {
  const base = hexToHsv(BLUE_300).h;
  for (const t of [0, 0.5, 1]) {
    const { h } = hexToHsv(brandRamp(t));
    // Hue barely drifts (HSV rounding), never sweeps across the wheel like a rainbow.
    expect(Math.abs(h - base)).toBeLessThan(12);
  }
  // t=0 is lighter (lower saturation) and t=1 is deeper (higher saturation, lower value).
  const light = hexToHsv(brandRamp(0));
  const deep = hexToHsv(brandRamp(1));
  expect(light.s).toBeLessThan(deep.s);
  expect(deep.v).toBeLessThan(light.v);
});

test("brandRamp follows a custom accent hue (so /accent recolors the sweep)", () => {
  const green = "#70f49a";
  expect(hexToHsv(brandRamp(0.5, green)).h).toBeCloseTo(hexToHsv(green).h, -1);
  expect(brandRamp(0.5, green)).not.toBe(brandRamp(0.5, BLUE_300));
});

test("brandSpans colors each character by column, preserving the text", () => {
  const spans = brandSpans("ABCD", 4);
  expect(spans.map((s) => s.ch).join("")).toBe("ABCD");
  expect(spans.every((s) => HEX.test(s.fg))).toBe(true);
  expect(spans[0]!.fg).not.toBe(spans[3]!.fg); // a real gradient, not flat
});
