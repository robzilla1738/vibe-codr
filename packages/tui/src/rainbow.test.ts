import { test, expect } from "bun:test";
import { rainbowAt, rainbowSpans, rotateHue } from "./rainbow.ts";

const HEX = /^#[0-9a-f]{6}$/;
const chan = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);

test("rainbowAt returns valid hex across the range and wraps", () => {
  for (const t of [0, 0.25, 0.5, 0.75, 1]) expect(rainbowAt(t)).toMatch(HEX);
  // t=1 wraps back to t=0 (avoids a hard seam), and distinct hues exist between.
  expect(rainbowAt(1)).toBe(rainbowAt(0));
  expect(rainbowAt(0.5)).not.toBe(rainbowAt(0));
  // Out-of-range values wrap modulo 1.
  expect(rainbowAt(1.5)).toBe(rainbowAt(0.5));
  expect(rainbowAt(-0.25)).toBe(rainbowAt(0.75));
});

test("the sweep starts red (red channel dominant) and moves off red", () => {
  const red = rainbowAt(0);
  expect(chan(red, 0)).toBeGreaterThan(chan(red, 2)); // R > B at the start
  expect(rainbowAt(0.6)).not.toBe(red);
});

test("rainbowSpans colors each character by column, preserving the text", () => {
  const spans = rainbowSpans("ABCD", 4);
  expect(spans.map((s) => s.ch).join("")).toBe("ABCD");
  expect(spans.every((s) => HEX.test(s.fg))).toBe(true);
  expect(spans[0]!.fg).not.toBe(spans[3]!.fg); // a real gradient, not flat
});

test("rotateHue gives distinct adjacent hues and cycles by `total`", () => {
  expect(rotateHue(0)).toMatch(HEX);
  expect(rotateHue(0)).not.toBe(rotateHue(1));
  expect(rotateHue(0, 7)).toBe(rotateHue(7, 7)); // wraps after `total`
  expect(rotateHue(-1, 7)).toBe(rotateHue(6, 7)); // negative indices wrap
});
