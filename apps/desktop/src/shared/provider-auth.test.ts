import { describe, expect, it } from "vitest";
import { isSubscriptionAuthStart, isSubscriptionAuthStatus } from "./provider-auth";

describe("subscription provider auth guards", () => {
  it("accepts bounded start and status shapes", () => {
    expect(isSubscriptionAuthStart({
      sessionId: "auth-1",
      providerId: "xai-oauth",
      method: "device",
      url: "https://accounts.x.ai/device",
      userCode: "ABCD-EFGH",
      expiresAt: Date.now() + 60_000,
    })).toBe(true);
    expect(isSubscriptionAuthStatus({
      sessionId: "auth-1",
      providerId: "xai-oauth",
      state: "pending",
      method: "device",
    })).toBe(true);
  });

  it("rejects unknown providers and malformed states", () => {
    expect(isSubscriptionAuthStatus({ providerId: "other", state: "connected" })).toBe(false);
    expect(isSubscriptionAuthStart({ providerId: "openai-codex", method: "browser" })).toBe(false);
  });
});
