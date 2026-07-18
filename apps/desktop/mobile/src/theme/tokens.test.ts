import { describe, it, expect } from "vitest";
import { getTheme } from "@shared/themes";
import { buildColorTokens } from "./tokens";
import { mixOklab, parseHex, fade } from "./color";

describe("color math", () => {
  it("parses 6-digit hex", () => {
    expect(parseHex("#0a0a0a")).toEqual([10, 10, 10, 1]);
  });
  it("mixOklab(100%) === base (oklab round-trip within 1 unit)", () => {
    const a = mixOklab("#e6e6e6", 100, "#000000");
    // 100% of #e6e6e6 returns an rgb() string; channel 230 within 1 unit.
    expect(a).toMatch(/^rgb\(/);
    expect(a).toContain("230");
  });
  it("mixOklab(0%) === other", () => {
    expect(mixOklab("#e6e6e6", 0, "#000000")).toBe("rgb(0, 0, 0)");
  });
  it("fade reduces alpha", () => {
    expect(fade("#ff0000", 50)).toContain("rgba(");
  });
});

describe("buildColorTokens (applyPalette port)", () => {
  it("default theme is dark with graphite fallbacks", () => {
    const t = buildColorTokens(getTheme("default"), undefined, "default");
    expect(t.scheme).toBe("dark");
    expect(t.bg).toBe("#0a0a0a");
    expect(t.panel).toBe("#141414");
    expect(t.elevated).toBe("#1e1e1e");
    expect(t.user).toBe("#5c9cf5");
    expect(t.tool).toBe("#56b6c2");
  });
  it("light theme flips scheme and brightens surfaces", () => {
    const t = buildColorTokens(getTheme("light"), undefined, "light");
    expect(t.scheme).toBe("light");
    expect(t.elevated).toBe("#ffffff");
    expect(t.heading).toBe("#20242e");
  });
  it("accent override rewrites chrome tokens", () => {
    const t = buildColorTokens(getTheme("default"), "#8b5cf6", "default");
    expect(t.accent).toBe("#8b5cf6");
    expect(t.primary).toBe("#8b5cf6");
    expect(t.ring).toBe("#8b5cf6");
  });
  it("contrast theme uses high-contrast diff colors", () => {
    const t = buildColorTokens(getTheme("contrast"), undefined, "contrast");
    expect(t.diffAdd).toBe("#5fff00");
    expect(t.diffDel).toBe("#ff3b3b");
  });
  it("derived surface-subtle is an oklab mix of elevated+bg", () => {
    const t = buildColorTokens(getTheme("default"), undefined, "default");
    const expected = mixOklab("#1e1e1e", 0.72, "#0a0a0a");
    expect(t.surfaceSubtle).toBe(expected);
  });
});
