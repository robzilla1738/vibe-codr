export const DEFAULT_SUMMARY_THRESHOLD = 0.75;
export const DEFAULT_OFFLOAD_THRESHOLD = 0.6;

export interface EffectiveCompactionThresholds {
  summary: number;
  configuredOffload: number;
  effectiveOffload: number;
  adjusted: boolean;
}

/** Mirror the engine's compaction layering transform for honest UI display. */
export function effectiveCompactionThresholds(
  summaryValue: number | undefined,
  offloadValue: number | undefined,
): EffectiveCompactionThresholds | null {
  const summary = summaryValue ?? DEFAULT_SUMMARY_THRESHOLD;
  const configuredOffload = offloadValue ?? DEFAULT_OFFLOAD_THRESHOLD;

  if (
    !Number.isFinite(summary)
    || summary < 0.1
    || summary > 0.95
    || !Number.isFinite(configuredOffload)
    || configuredOffload < 0.1
    || configuredOffload > 0.9
  ) {
    return null;
  }

  const adjusted = configuredOffload >= summary;
  return {
    summary,
    configuredOffload,
    effectiveOffload: adjusted ? summary - 0.05 : configuredOffload,
    adjusted,
  };
}

export function formatThresholdPercent(value: number): string {
  return `${Math.round(value * 1_000) / 10}%`;
}
