import { isPrivateNetworkAddress } from "@shared/private-network";
import type { ConnectionConfig } from "./connection";

export type ConnectionValidation =
  | { ok: true; value: ConnectionConfig }
  | { ok: false; error: string };

export function validateConnectionConfig(config: ConnectionConfig): ConnectionValidation {
  const accessToken = config.accessToken.trim();
  const cwd = config.cwd.trim();
  const rawUrl = config.url.trim();
  if (!accessToken || accessToken.length > 16_384 || accessToken.includes("\0")) {
    return { ok: false, error: "Enter a valid pairing token." };
  }
  if (!isAbsoluteDesktopPath(cwd) || cwd.length > 32_768 || cwd.includes("\0")) {
    return { ok: false, error: "Enter the absolute project path shown by your desktop." };
  }
  if (!rawUrl || rawUrl.length > 2_048) return { ok: false, error: "Enter a valid relay URL." };
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { ok: false, error: "Enter a valid relay URL." }; }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return { ok: false, error: "Relay URLs must use ws:// or wss://." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Keep credentials out of the relay URL; use the pairing-token field." };
  }
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (url.protocol === "ws:" && !isPrivateNetworkAddress(hostname)) {
    return { ok: false, error: "Plain ws:// pairing is limited to private LAN or Tailnet IP addresses. Use wss:// for public routing." };
  }
  if (config.sessionId !== undefined && (!config.sessionId.trim() || config.sessionId.length > 1_024 || config.sessionId.includes("\0"))) {
    return { ok: false, error: "This pairing link contains an invalid session identifier." };
  }
  return {
    ok: true,
    value: {
      ...config,
      url: url.toString(),
      accessToken,
      cwd,
      ...(config.sessionId ? { sessionId: config.sessionId.trim() } : {}),
    },
  };
}

export function parsePairingDeepLink(value: string | null): ConnectionValidation | null {
  if (!value) return null;
  let link: URL;
  try { link = new URL(value); } catch { return null; }
  if (link.protocol !== "vibecodr:" || link.hostname !== "connect") return null;
  const url = link.searchParams.get("url");
  const accessToken = link.searchParams.get("token");
  const cwd = link.searchParams.get("cwd");
  const sessionId = link.searchParams.get("session");
  if (!url || !accessToken || !cwd) return { ok: false, error: "This pairing link is incomplete." };
  return validateConnectionConfig({ url, accessToken, cwd, ...(sessionId ? { sessionId } : {}) });
}

function isAbsoluteDesktopPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
