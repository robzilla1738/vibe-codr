import { lookup } from "node:dns/promises";
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

const defaultLookup: Lookup = (host) => lookup(host, { all: true });

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
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  // IPv4-mapped/compat (::ffff:1.2.3.4 or ::1.2.3.4) — judge the embedded v4.
  const mapped = addr.match(/(?:^|:):(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);
  const first = parseInt(addr.split(":")[0] || "0", 16);
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 unique-local
  if (first >= 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Validate a URL against the SSRF policy and return the parsed URL. Rejects
 * non-HTTP(S) schemes, `localhost`, IP literals in a private range, and
 * hostnames that *resolve* to a private address (catching the DNS form of the
 * attack). `allowHosts` / `allowPrivateHosts` open explicit holes.
 */
export async function assertFetchAllowed(
  rawUrl: string,
  policy: FetchPolicy = {},
  lookupFn: Lookup = defaultLookup,
): Promise<URL> {
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
  if (policy.allowHosts?.includes(host)) return u;
  if (policy.allowPrivateHosts) return u;
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error(`refusing to fetch a private/link-local address (${host})`);
    }
    return u;
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
  return u;
}
