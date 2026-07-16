/**
 * Normalize engine context telemetry for renderer chrome. Host validation
 * rejects impossible values, but this remains defensive because the helper is
 * also used by preview/test state and keeps CSS custom properties bounded.
 */
export function contextUsagePercent(usedTokens: number, contextWindow: number): number | null {
  if (!Number.isFinite(usedTokens) || usedTokens < 0) return null;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((100 * usedTokens) / contextWindow)));
}
