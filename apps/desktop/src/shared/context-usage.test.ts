import { describe, expect, it } from "vitest";
import { contextUsagePercent } from "./context-usage";

describe("contextUsagePercent", () => {
  it("reports bounded context fill", () => {
    expect(contextUsagePercent(64_000, 128_000)).toBe(50);
    expect(contextUsagePercent(200_000, 128_000)).toBe(100);
  });

  it("rejects impossible telemetry instead of leaking it into UI state", () => {
    expect(contextUsagePercent(-1, 128_000)).toBeNull();
    expect(contextUsagePercent(1, 0)).toBeNull();
    expect(contextUsagePercent(Number.NaN, 128_000)).toBeNull();
    expect(contextUsagePercent(1, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
