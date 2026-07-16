import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type Lookup = (hostname: string) => Promise<Array<{ address: string }>>;

export async function assertPublicProviderDomains(
  domains: string[],
  resolveAll: Lookup = async (hostname) => await lookup(hostname, { all: true, verbatim: true }),
): Promise<void> {
  for (const domain of new Set(domains)) {
    const addresses = isIP(domain) ? [{ address: domain }] : await resolveAll(domain);
    if (!addresses.length || addresses.some(({ address }) => isNonPublicIpAddress(address))) {
      throw new Error(`${domain} does not resolve exclusively to public addresses. Choose a public HTTPS provider endpoint before handing off.`);
    }
  }
}

export function isNonPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isNonPublicIpv4(address.split(".").map(Number));
  if (version !== 6) return false;
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  if (bytes.every((byte) => byte === 0)) return true;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
  if (bytes.slice(0, 12).every((byte) => byte === 0)) return isNonPublicIpv4(bytes.slice(12));
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isNonPublicIpv4(bytes.slice(12));
  }
  if (bytes.slice(0, 8).every((byte) => byte === 0) && bytes[8] === 0xff && bytes[9] === 0xff
    && bytes[10] === 0 && bytes[11] === 0) return isNonPublicIpv4(bytes.slice(12));
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (bytes[4] === 0 && bytes[5] === 1) return true;
    if (bytes.slice(4, 12).every((byte) => byte === 0)) return isNonPublicIpv4(bytes.slice(12));
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02 && isNonPublicIpv4(bytes.slice(2, 6))) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true;
  if (bytes[0] === 0xff) return true;
  return bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
}

function isNonPublicIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes;
  return bytes.length !== 4
    || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    || a === 0
    || a === 10
    || a === 100 && b >= 64 && b <= 127
    || a === 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 0 && (c === 0 || c === 2)
    || a === 192 && b === 168
    || a === 198 && (b === 18 || b === 19)
    || a === 198 && b === 51 && c === 100
    || a === 203 && b === 0 && c === 113
    || a >= 224;
}

function ipv6Bytes(input: string): number[] | null {
  const address = input.split("%")[0].toLowerCase();
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const words: number[] = [];
    for (const token of part.split(":")) {
      if (token.includes(".")) {
        const ipv4 = token.split(".").map(Number);
        if (!isValidIpv4(ipv4)) return null;
        words.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        const word = Number.parseInt(token, 16);
        if (!/^[0-9a-f]{1,4}$/.test(token) || !Number.isFinite(word)) return null;
        words.push(word);
      }
    }
    return words;
  };
  const left = parse(halves[0]);
  const right = parse(halves[1] ?? "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill(0), ...right];
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

function isValidIpv4(bytes: number[]): boolean {
  return bytes.length === 4 && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}
