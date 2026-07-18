export function normalizeIpAddress(address: string): string {
  const zoneIndex = address.indexOf("%");
  const withoutZone = zoneIndex >= 0 ? address.slice(0, zoneIndex) : address;
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice(7) : withoutZone;
}

export function isPrivateNetworkAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address).toLowerCase();
  if (normalized === "::1" || normalized === "localhost") return true;

  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = octets;
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

export function privateLanIPv4(
  interfaces: NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>,
): string | null {
  for (const list of Object.values(interfaces)) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal && isPrivateNetworkAddress(iface.address)) return iface.address;
    }
  }
  return null;
}
