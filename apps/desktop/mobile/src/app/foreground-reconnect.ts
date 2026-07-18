import type { AppStateStatus } from "react-native";

export const FOREGROUND_RECONNECT_AFTER_MS = 10_000;

export function shouldRefreshAfterForeground(
  previous: AppStateStatus,
  next: AppStateStatus,
  suspendedAt: number | null,
  now: number,
): boolean {
  return previous !== "active"
    && next === "active"
    && suspendedAt !== null
    && now - suspendedAt >= FOREGROUND_RECONNECT_AFTER_MS;
}
