import { lookup } from "node:dns/promises";
import { ADDRCONFIG } from "node:dns";
import { isIP } from "node:net";

/**
 * SSRF policy for outbound fetches (webfetch). Default-deny: private, loopback,
 * link-local, and cloud-metadata addresses are refused unless explicitly opted
 * into — a prompt-injected page must not be able to make the agent read
 * `http://169.254.169.254/…` IAM credentials or probe the internal network.
 */
export interface FetchPolicy {
  /** Permit private/loopback/link-local hosts (intranet docs you trust). */
  allowPrivateHosts?: boolean;
  /** Hostnames always allowed, even if they resolve to a private address. */
  allowHosts?: string[];
}

/** Injectable DNS resolver (so the guard is testable without real network). */
export type Lookup = (host: string) => Promise<{ address: string }[]>;

// ADDRCONFIG: only return address families the host actually has connectivity
// for, so an IPv4-only box (Docker's default bridge, many CI runners) doesn't get
// AAAA records it can't reach — important because we PIN to one of these below and
// lose the runtime's Happy-Eyeballs fallback.
const defaultLookup: Lookup = (host) => lookup(host, { all: true, hints: ADDRCONFIG });

/** Is `ip` (a v4 or v6 literal) loopback / link-local / private / metadata? */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true; // not a recognizable IP literal — treat as unsafe
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0/24 (IETF protocol assignments)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224+/4 multicast + reserved/future
  return false;
}

function isPrivateV6(ip: string): boolean {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%"); // strip scope id (fe80::1%eth0)
  if (zone !== -1) addr = addr.slice(0, zone);
  // Fully expand to 8 hextets so every judgment works on canonical bytes. This
  // is critical for IPv4-mapped addresses: `new URL()` normalizes
  // `[::ffff:169.254.169.254]` to the HEX form `::ffff:a9fe:a9fe`, so a
  // dotted-decimal-only match (the old code) let metadata/loopback through the
  // guard. We reconstruct the embedded v4 from the low 32 bits instead.
  const h = expandV6(addr);
  if (!h) return true; // unparseable literal — treat as unsafe
  const firstFiveZero =
    h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
  // The OS routes IPv4-mapped (::ffff:a.b.c.d — h[5]===0xffff) and deprecated
  // IPv4-compatible (::a.b.c.d — h[5]===0) addresses to the embedded IPv4, so
  // reconstruct it from the low 32 bits and judge THAT. `::` (unspecified) and
  // `::1` (loopback) fall under the compat form and resolve to private v4s too.
  if (firstFiveZero && (h[5] === 0xffff || h[5] === 0)) {
    if (h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true; // :: / ::1
    const g6 = h[6]!;
    const g7 = h[7]!;
    return isPrivateV4(`${g6 >>> 8}.${g6 & 0xff}.${g7 >>> 8}.${g7 & 0xff}`);
  }
  const first = h[0]!;
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 unique-local
  if (first >= 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Expand an IPv6 literal (already lower-cased, zone stripped) into its 8 16-bit
 * hextets, resolving `::` compression and a trailing embedded dotted IPv4
 * (`::ffff:1.2.3.4`). Returns null for anything it can't parse, so the caller
 * fails closed. Input is assumed to have passed `isIP(...) === 6`.
 */
function expandV6(input: string): number[] | null {
  let addr = input;
  // Convert a trailing dotted-decimal IPv4 tail into two hextets.
  const dotted = addr.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const octets = [dotted[2], dotted[3], dotted[4], dotted[5]].map(Number);
    if (octets.some((n) => n > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    addr = `${dotted[1]}${hi}:${lo}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  let parts: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null; // no `::`, must be fully specified
    parts = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    parts = [...head, ...new Array<string>(missing).fill("0"), ...tail];
    if (parts.length !== 8) return null;
  }
  const hextets = parts.map((p) => parseInt(p || "0", 16));
  return hextets.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : hextets;
}

/** The result of an allowed fetch check: the parsed URL, plus the verified IP to
 * PIN the connection to (set only when a hostname was resolved) so a DNS rebind
 * between the check and the connection can't redirect it to a private address. */
export interface FetchTarget {
  url: URL;
  /** The single public IP the hostname resolved to; connect to exactly this. */
  pinnedIp?: string;
}

/**
 * Validate a URL against the SSRF policy and return the parsed URL plus (for a
 * resolved hostname) the verified IP to pin the connection to. Rejects non-HTTP(S)
 * schemes, `localhost`, IP literals in a private range, and hostnames that
 * *resolve* to a private address (catching the DNS form of the attack).
 * `allowHosts` / `allowPrivateHosts` open explicit holes (and skip pinning, so
 * intranet names that resolve locally still work).
 *
 * DNS-rebinding defense: a hostname is resolved ONCE here and the verified IP is
 * returned as `pinnedIp`; the caller connects to that exact IP (keeping the
 * original Host header + TLS SNI), so an attacker who returns a public IP to this
 * lookup and a private one to a second resolution can't slip through the window.
 */
export async function assertFetchAllowed(
  rawUrl: string,
  policy: FetchPolicy = {},
  lookupFn: Lookup = defaultLookup,
): Promise<FetchTarget> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`refusing to fetch a non-HTTP(S) URL (${u.protocol}//…)`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ""); // unwrap [::1]
  if (policy.allowHosts?.includes(host)) return { url: u };
  if (policy.allowPrivateHosts) return { url: u };
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error(`refusing to fetch a private/link-local address (${host})`);
    }
    return { url: u }; // literal target — fetch connects to it directly, no DNS
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`refusing to fetch ${host} (set webfetch.allowPrivateHosts to override)`);
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookupFn(host);
  } catch {
    throw new Error(`could not resolve ${host}`);
  }
  if (!addrs.length) throw new Error(`could not resolve ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error(
        `refusing to fetch ${host}: it resolves to a private address (${a.address})`,
      );
    }
  }
  // Every resolved address is public — pin to one so the connection can't be
  // re-resolved to a private address (DNS rebinding). Prefer a verified IPv4: it's
  // reachable in the widest set of environments (IPv6 is often configured but not
  // internet-routable in containers/CI, and `lookup` returns AAAA first for many
  // dual-stack hosts), so blindly pinning addrs[0] would break those. Fall back to
  // the first address for IPv6-only hosts.
  const pinnedIp = (addrs.find((a) => isIP(a.address) === 4) ?? addrs[0]!).address;
  return { url: u, pinnedIp };
}
