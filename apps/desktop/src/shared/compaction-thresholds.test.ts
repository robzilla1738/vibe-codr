import { describe, expect, it } from "vitest";
import {
  effectiveCompactionThresholds,
  formatThresholdPercent,
} from "./compaction-thresholds";

describe("effectiveCompactionThresholds", () => {
  it("uses engine defaults when both fields are omitted", () => {
    expect(effectiveCompactionThresholds(undefined, undefined)).toEqual({
      summary: 0.75,
      configuredOffload: 0.6,
      effectiveOffload: 0.6,
      adjusted: false,
    });
  });

  it("mirrors the engine clamp for an inverted explicit pair", () => {
    expect(effectiveCompactionThresholds(0.5, 0.9)).toEqual({
      summary: 0.5,
      configuredOffload: 0.9,
      effectiveOffload: 0.45,
      adjusted: true,
    });
  });

  it("accounts for the default offload threshold after summary is lowered", () => {
    expect(effectiveCompactionThresholds(0.4, undefined)?.effectiveOffload).toBeCloseTo(0.35);
  });

  it("keeps the lossless layer below the minimum summary threshold", () => {
    expect(effectiveCompactionThresholds(0.1, 0.1)?.effectiveOffload).toBeCloseTo(0.05);
  });

  it("does not describe values the engine schema would reject", () => {
    expect(effectiveCompactionThresholds(1, 0.6)).toBeNull();
    expect(effectiveCompactionThresholds(0.75, Number.NaN)).toBeNull();
  });

  it("formats whole and fractional percentages without floating-point noise", () => {
    expect(formatThresholdPercent(0.45)).toBe("45%");
    expect(formatThresholdPercent(0.055)).toBe("5.5%");
  });
});
