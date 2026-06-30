import { test, expect } from "bun:test";
import { isPrivateIp, assertFetchAllowed } from "./net-guard.ts";

test("isPrivateIp flags loopback / link-local / private / metadata v4", () => {
  for (const ip of [
    "127.0.0.1",
    "169.254.169.254", // cloud metadata
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "224.0.0.1", // multicast
  ]) {
    expect(isPrivateIp(ip)).toBe(true);
  }
});

test("isPrivateIp allows ordinary public v4", () => {
  for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.15.0.1", "172.32.0.1"]) {
    expect(isPrivateIp(ip)).toBe(false);
  }
});

test("isPrivateIp handles v6 loopback / link-local / ULA / mapped", () => {
  for (const ip of [
    "::1",
    "::",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:169.254.169.254", // IPv4-mapped metadata
    "::ffff:10.0.0.1",
  ]) {
    expect(isPrivateIp(ip)).toBe(true);
  }
  expect(isPrivateIp("2606:4700:4700::1111")).toBe(false); // public (1.1.1.1 v6)
  expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false); // mapped public
});

test("assertFetchAllowed rejects non-HTTP schemes", async () => {
  await expect(assertFetchAllowed("file:///etc/passwd")).rejects.toThrow(/non-HTTP/);
  await expect(assertFetchAllowed("ftp://example.com")).rejects.toThrow(/non-HTTP/);
});

test("assertFetchAllowed blocks an IP-literal metadata host without DNS", async () => {
  await expect(
    assertFetchAllowed("http://169.254.169.254/latest/meta-data/", {}, async () => {
      throw new Error("lookup should not run for an IP literal");
    }),
  ).rejects.toThrow(/private\/link-local/);
});

test("assertFetchAllowed blocks a hostname that resolves to a private IP", async () => {
  await expect(
    assertFetchAllowed("https://sneaky.example.com", {}, async () => [{ address: "10.0.0.5" }]),
  ).rejects.toThrow(/private address/);
});

test("assertFetchAllowed blocks localhost by name", async () => {
  await expect(assertFetchAllowed("http://localhost:9000/")).rejects.toThrow(/localhost/);
});

test("assertFetchAllowed allows a public resolution", async () => {
  const u = await assertFetchAllowed("https://example.com/x", {}, async () => [
    { address: "93.184.216.34" },
  ]);
  expect(u.hostname).toBe("example.com");
});

test("allowPrivateHosts / allowHosts open explicit holes", async () => {
  // allowPrivateHosts short-circuits the resolution entirely.
  await expect(
    assertFetchAllowed("http://localhost:8080/", { allowPrivateHosts: true }),
  ).resolves.toBeDefined();
  // allowHosts whitelists a specific name even if it would resolve privately.
  await expect(
    assertFetchAllowed("http://internal.dev/", { allowHosts: ["internal.dev"] }, async () => [
      { address: "10.0.0.9" },
    ]),
  ).resolves.toBeDefined();
});
