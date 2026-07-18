import { describe, expect, it } from "vitest";
import { FOREGROUND_RECONNECT_AFTER_MS, shouldRefreshAfterForeground } from "./foreground-reconnect";

describe("foreground reconnect policy", () => {
  it("refreshes only after a meaningful suspended interval", () => {
    expect(shouldRefreshAfterForeground("background", "active", 1_000, 1_000 + FOREGROUND_RECONNECT_AFTER_MS)).toBe(true);
    expect(shouldRefreshAfterForeground("inactive", "active", 1_000, 1_000 + FOREGROUND_RECONNECT_AFTER_MS - 1)).toBe(false);
    expect(shouldRefreshAfterForeground("active", "active", 1_000, 50_000)).toBe(false);
    expect(shouldRefreshAfterForeground("background", "inactive", 1_000, 50_000)).toBe(false);
  });
});
