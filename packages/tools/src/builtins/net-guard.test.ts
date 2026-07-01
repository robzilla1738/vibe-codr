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

test("isPrivateIp flags IPv4-mapped v6 in the HEX form the URL parser emits", () => {
  // `new URL("http://[::ffff:169.254.169.254]/")` normalizes the hostname to the
  // hex-compressed form, which the old dotted-only matcher missed → SSRF bypass.
  for (const [dotted, hex] of [
    ["::ffff:169.254.169.254", "::ffff:a9fe:a9fe"], // cloud metadata
    ["::ffff:127.0.0.1", "::ffff:7f00:1"], // loopback
    ["::ffff:10.0.0.1", "::ffff:a00:1"], // private
    ["::ffff:192.168.1.1", "::ffff:c0a8:101"], // private
  ] as const) {
    // The exact string the WHATWG URL parser produces is what reaches the guard.
    expect(new URL(`http://[${dotted}]/`).hostname).toBe(`[${hex}]`);
    expect(isPrivateIp(hex)).toBe(true);
  }
  // A public mapped address stays allowed in the hex form too (8.8.8.8).
  expect(new URL("http://[::ffff:8.8.8.8]/").hostname).toBe("[::ffff:808:808]");
  expect(isPrivateIp("::ffff:808:808")).toBe(false);
  // A malformed/garbage v6 literal fails closed (treated as private).
  expect(isPrivateIp("::ffff:zzzz:1")).toBe(true);
});

test("assertFetchAllowed blocks the hex IPv4-mapped metadata literal (real URL path)", async () => {
  // End-to-end: the bracketed literal a prompt-injected page would supply.
  await expect(
    assertFetchAllowed("http://[::ffff:169.254.169.254]/latest/meta-data/", {}, async () => {
      throw new Error("lookup should not run for an IP literal");
    }),
  ).rejects.toThrow(/private\/link-local/);
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

test("assertFetchAllowed allows a public resolution and PINS the verified IP", async () => {
  const t = await assertFetchAllowed("https://example.com/x", {}, async () => [
    { address: "93.184.216.34" },
  ]);
  expect(t.url.hostname).toBe("example.com");
  // The verified IP is returned so the caller connects to exactly it (anti-rebind).
  expect(t.pinnedIp).toBe("93.184.216.34");
});

test("assertFetchAllowed pins a verified IPv4 when the host is dual-stack (reachability)", async () => {
  // `lookup` often returns IPv6 first, but IPv6 is frequently not routable in
  // containers/CI — pinning must prefer the verified IPv4 so webfetch still works.
  const t = await assertFetchAllowed("https://dual.example/x", {}, async () => [
    { address: "2606:2800:220:1:248:1893:25c8:1946" },
    { address: "93.184.216.34" },
  ]);
  expect(t.pinnedIp).toBe("93.184.216.34");
});

test("assertFetchAllowed pins the IPv6 address for an IPv6-only host", async () => {
  const t = await assertFetchAllowed("https://v6only.example/x", {}, async () => [
    { address: "2606:2800:220:1:248:1893:25c8:1946" },
  ]);
  expect(t.pinnedIp).toBe("2606:2800:220:1:248:1893:25c8:1946");
});

test("assertFetchAllowed does NOT pin an IP literal or an opted-in host", async () => {
  // An IP literal target has no DNS to pin.
  const lit = await assertFetchAllowed("http://93.184.216.34/x");
  expect(lit.pinnedIp).toBeUndefined();
  // allowHosts / allowPrivateHosts skip resolution → no pin (local resolution
  // still works for intranet names).
  const allowed = await assertFetchAllowed(
    "http://internal.dev/",
    { allowHosts: ["internal.dev"] },
    async () => [{ address: "10.0.0.9" }],
  );
  expect(allowed.pinnedIp).toBeUndefined();
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
