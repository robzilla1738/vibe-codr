export const PERFORMANCE_PHASES = [
  "host-spawn",
  "host-ready",
  "snapshot",
  "replay",
  "provider-ttft",
  "generation",
  "tool-execution",
  "bridge-delay",
  "first-paint",
] as const;

export type PerformancePhase = (typeof PERFORMANCE_PHASES)[number];

export interface PerformancePhaseSample {
  phase: PerformancePhase;
  durationMs: number;
  transport: "local" | "cloud";
}

export interface PerformancePercentiles {
  count: number;
  p50: number;
  p95: number;
}

export interface PerformanceSummary {
  days: 1 | 7;
  generatedAt: number;
  since: number;
  turnCount: number;
  phases: Partial<Record<PerformancePhase, PerformancePercentiles>>;
  toolSchemaTokens?: PerformancePercentiles;
  dominantBottleneck?: { phase: PerformancePhase; p95Ms: number };
}

export interface PerformanceDiagnosticsBundle {
  formatVersion: 2;
  generatedAt: number;
  app: {
    version: string;
    platform: string;
    architecture: string;
    protocolVersion: number;
    launchKind?: "compiled" | "source" | "bundled" | "development" | "cloud";
  };
  performance: {
    lastDay: PerformanceSummary;
    lastWeek: PerformanceSummary;
  };
  /** Bounded content-free event order for diagnosing late/stuck tool turns. */
  eventTrace: DiagnosticEventTraceEntry[];
}

export interface DiagnosticEventTraceEntry {
  at: number;
  type: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  status?: string;
  revision?: number;
}

/** Reduce a host resolver description to a path-free diagnostics category. */
export function diagnosticLaunchKind(
  description: string,
): PerformanceDiagnosticsBundle["app"]["launchKind"] {
  if (description.startsWith("compiled ")) return "compiled";
  if (description.startsWith("bun ")) return "source";
  if (description.startsWith("bundled ")) return "bundled";
  if (description.startsWith("dev resources ")) return "development";
  if (description === "Cloud agent") return "cloud";
  return undefined;
}
