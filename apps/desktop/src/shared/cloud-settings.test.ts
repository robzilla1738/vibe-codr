import { describe, expect, it } from "vitest";
import { parseCloudSettingsPatch } from "./cloud-settings";

describe("Cloud settings boundary", () => {
  it("normalizes supported handoff settings", () => {
    expect(parseCloudSettingsPatch({
      transferModelCredentials: true,
      autoPauseMinutes: 15,
      allowedDomains: ["API.Example.COM", "api.example.com"],
      additionalExclusions: ["./fixtures/private", "large-*.bin"],
    })).toEqual({
      transferModelCredentials: true,
      autoPauseMinutes: 15,
      allowedDomains: ["api.example.com"],
      additionalExclusions: ["fixtures/private", "large-*.bin"],
    });
  });

  it("rejects fields and values that could corrupt durable settings", () => {
    expect(() => parseCloudSettingsPatch({ providers: {} })).toThrow("unsupported field");
    expect(() => parseCloudSettingsPatch({ autoPauseMinutes: 0 })).toThrow("1 to 120");
    expect(() => parseCloudSettingsPatch({ allowedDomains: ["https://api.example.com"] })).toThrow("hostname");
    expect(() => parseCloudSettingsPatch({ additionalExclusions: ["../outside"] })).toThrow("workspace exclusion");
  });
});
