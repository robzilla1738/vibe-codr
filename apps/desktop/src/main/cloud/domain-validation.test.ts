import { describe, expect, it } from "vitest";
import { assertPublicProviderDomains, isNonPublicIpAddress } from "./domain-validation";

describe("cloud provider domain validation", () => {
  it("rejects private DNS answers and mapped IPv6 metadata addresses", async () => {
    expect(isNonPublicIpAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isNonPublicIpAddress("::10.0.0.1")).toBe(true);
    expect(isNonPublicIpAddress("::ffff:0:10.0.0.1")).toBe(true);
    expect(isNonPublicIpAddress("64:ff9b::10.0.0.1")).toBe(true);
    expect(isNonPublicIpAddress("64:ff9b:1::1")).toBe(true);
    expect(isNonPublicIpAddress("2002:0a00:0001::1")).toBe(true);
    expect(isNonPublicIpAddress("fec0::1")).toBe(true);
    expect(isNonPublicIpAddress("2606:4700:4700::1111")).toBe(false);
    expect(isNonPublicIpAddress("198.51.1.1")).toBe(false);
    expect(isNonPublicIpAddress("203.0.1.1")).toBe(false);
    expect(isNonPublicIpAddress("192.0.3.1")).toBe(false);
    await expect(assertPublicProviderDomains(["provider.example"], async () => [
      { address: "203.0.113.8" },
      { address: "10.0.0.4" },
    ])).rejects.toThrow("public addresses");
    await expect(assertPublicProviderDomains(["provider.example"], async () => [
      { address: "1.1.1.1" },
      { address: "2606:4700:4700::1111" },
    ])).resolves.toBeUndefined();
  });
});
