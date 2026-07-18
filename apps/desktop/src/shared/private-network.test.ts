import { describe, expect, it } from "vitest";
import { isPrivateNetworkAddress, normalizeIpAddress, privateLanIPv4 } from "./private-network";

describe("private network relay boundary", () => {
  it("accepts local, RFC1918, link-local, and tailnet IPv4 addresses", () => {
    for (const address of ["127.0.0.1", "10.4.3.2", "172.16.0.1", "172.31.255.254", "192.168.1.5", "169.254.4.8", "100.64.0.1", "100.127.255.254", "::1"]) {
      expect(isPrivateNetworkAddress(address), address).toBe(true);
    }
  });

  it("rejects public and malformed addresses", () => {
    for (const address of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:4860:4860::8888", "not-an-ip", "999.1.1.1"]) {
      expect(isPrivateNetworkAddress(address), address).toBe(false);
    }
  });

  it("normalizes IPv4-mapped socket addresses and selects only private LAN interfaces", () => {
    expect(normalizeIpAddress("::ffff:192.168.0.9")).toBe("192.168.0.9");
    expect(privateLanIPv4({
      public: [{ address: "203.0.113.8", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "203.0.113.8/24" }],
      wifi: [{ address: "192.168.0.9", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:01", internal: false, cidr: "192.168.0.9/24" }],
    })).toBe("192.168.0.9");
  });
});
