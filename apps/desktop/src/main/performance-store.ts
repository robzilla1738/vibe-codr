import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TurnPerformanceSample } from "../shared/events";
import {
  PERFORMANCE_PHASES,
  type PerformancePercentiles,
  type PerformancePhase,
  type PerformancePhaseSample,
  type PerformanceSummary,
} from "../shared/performance";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_BYTES = 2 * 1024 * 1024;

interface StoredPerformanceRecord {
  recordedAt: number;
  kind: "turn" | "paint" | "phase";
  turnId?: string;
  sessionId?: string;
  sample?: TurnPerformanceSample;
  bridgeDelayMs?: number;
  bridgeToPaintMs?: number;
  phase?: PerformancePhase;
  durationMs?: number;
  transport?: "local" | "cloud";
}

const REQUIRED_DURATION_KEYS = [
  "startedAt",
  "queueDelayMs",
  "hooksMs",
  "checkpointMs",
  "recallMs",
  "attachmentsMs",
  "modelResolveMs",
  "contextPrepareMs",
  "generationMs",
  "toolMs",
  "persistMs",
  "postTurnMs",
  "totalMs",
] as const;

const OPTIONAL_NUMBER_KEYS = [
  "providerTtftMs",
  "firstReasoningMs",
  "firstVisibleTextMs",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "toolSchemaTokens",
] as const;

/** Copy only the explicitly content-free contract fields before persistence. */
function sanitizeSample(value: unknown): TurnPerformanceSample | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (
    typeof input.turnId !== "string" ||
    typeof input.sessionId !== "string" ||
    typeof input.model !== "string" ||
    (input.serviceTier !== "default" && input.serviceTier !== "priority") ||
    REQUIRED_DURATION_KEYS.some(
      (key) => typeof input[key] !== "number" || !Number.isFinite(input[key]),
    )
  ) {
    return undefined;
  }
  const sample = {
    turnId: input.turnId,
    sessionId: input.sessionId,
    model: input.model,
    serviceTier: input.serviceTier,
  } as TurnPerformanceSample;
  for (const key of REQUIRED_DURATION_KEYS) sample[key] = input[key] as number;
  for (const key of OPTIONAL_NUMBER_KEYS) {
    if (typeof input[key] === "number" && Number.isFinite(input[key])) {
      sample[key] = input[key] as number;
    }
  }
  return sample;
}

/** Bounded, content-free, machine-local performance history. */
export class PerformanceStore {
  readonly #path: string;
  readonly #now: () => number;
  #writeTail: Promise<void> = Promise.resolve();
  #activeTurn = new Map<string, string>();
  #firstDeltaAt = new Map<string, number>();

  constructor(userData: string, options: { now?: () => number } = {}) {
    this.#path = join(userData, "performance", "turns.jsonl");
    this.#now = options.now ?? Date.now;
  }

  observeEngineEvent(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const value = event as { type?: unknown; sessionId?: unknown; turnId?: unknown; subagentId?: unknown; sample?: unknown };
    if (typeof value.sessionId !== "string") return;
    if (value.type === "user-message" && typeof value.turnId === "string") {
      this.#activeTurn.set(value.sessionId, value.turnId);
      return;
    }
    if (value.type === "assistant-text-delta" && value.subagentId === undefined) {
      const turnId = this.#activeTurn.get(value.sessionId);
      if (turnId && !this.#firstDeltaAt.has(turnId)) this.#firstDeltaAt.set(turnId, this.#now());
      return;
    }
    if (value.type !== "turn-performance") return;
    const sample = sanitizeSample(value.sample);
    if (!sample || typeof sample.turnId !== "string" || sample.sessionId !== value.sessionId) return;
    const receivedAt = this.#now();
    this.#append({
      recordedAt: receivedAt,
      kind: "turn",
      turnId: sample.turnId,
      sessionId: sample.sessionId,
      sample,
      bridgeDelayMs: Math.max(0, receivedAt - (sample.startedAt + sample.totalMs)),
    });
    this.#activeTurn.delete(value.sessionId);
  }

  recordFirstPaint(input: { turnId: string; sessionId: string; paintedAt: number }): void {
    const firstDeltaAt = this.#firstDeltaAt.get(input.turnId);
    if (firstDeltaAt === undefined) return;
    this.#firstDeltaAt.delete(input.turnId);
    this.#append({
      recordedAt: this.#now(),
      kind: "paint",
      turnId: input.turnId,
      sessionId: input.sessionId,
      bridgeToPaintMs: Math.max(0, input.paintedAt - firstDeltaAt),
    });
  }

  recordPhase(sample: PerformancePhaseSample): void {
    if (
      !PERFORMANCE_PHASES.includes(sample.phase)
      || !Number.isFinite(sample.durationMs)
      || sample.durationMs < 0
      || (sample.transport !== "local" && sample.transport !== "cloud")
    ) return;
    this.#append({
      recordedAt: this.#now(),
      kind: "phase",
      phase: sample.phase,
      durationMs: sample.durationMs,
      transport: sample.transport,
    });
  }

  async getPerformanceSummary(input: { days: 1 | 7 }): Promise<PerformanceSummary> {
    await this.flush();
    const generatedAt = this.#now();
    const since = generatedAt - input.days * 24 * 60 * 60 * 1_000;
    const records = await this.#readRecords(since);
    const values = new Map<PerformancePhase, number[]>();
    const schemaTokens: number[] = [];
    const turnIds = new Set<string>();
    const add = (phase: PerformancePhase, duration: unknown) => {
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return;
      const phaseValues = values.get(phase) ?? [];
      phaseValues.push(duration);
      values.set(phase, phaseValues);
    };
    for (const record of records) {
      if (record.kind === "phase" && record.phase) {
        add(record.phase, record.durationMs);
        continue;
      }
      if (record.kind === "paint") {
        add("first-paint", record.bridgeToPaintMs);
        continue;
      }
      const sample = record.sample;
      if (!sample) continue;
      turnIds.add(sample.turnId);
      add("provider-ttft", sample.providerTtftMs);
      add("generation", sample.generationMs);
      add("tool-execution", sample.toolMs);
      add("bridge-delay", record.bridgeDelayMs);
      if (typeof sample.toolSchemaTokens === "number" && Number.isFinite(sample.toolSchemaTokens) && sample.toolSchemaTokens >= 0) {
        schemaTokens.push(sample.toolSchemaTokens);
      }
    }
    const phases: PerformanceSummary["phases"] = {};
    for (const phase of PERFORMANCE_PHASES) {
      const phaseValues = values.get(phase);
      if (phaseValues?.length) phases[phase] = percentiles(phaseValues);
    }
    const dominant = PERFORMANCE_PHASES
      .map((phase) => ({ phase, p95Ms: phases[phase]?.p95 ?? -1 }))
      .filter((entry) => entry.p95Ms >= 0)
      .sort((a, b) => b.p95Ms - a.p95Ms)[0];
    return {
      days: input.days,
      generatedAt,
      since,
      turnCount: turnIds.size,
      phases,
      ...(schemaTokens.length ? { toolSchemaTokens: percentiles(schemaTokens) } : {}),
      ...(dominant ? { dominantBottleneck: dominant } : {}),
    };
  }

  /** Ensure queued samples reach disk before app shutdown or deterministic tests. */
  flush(): Promise<void> {
    return this.#writeTail;
  }

  #append(record: StoredPerformanceRecord): void {
    this.#writeTail = this.#writeTail.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      let lines: string[] = [];
      try { lines = (await readFile(this.#path, "utf8")).split("\n").filter(Boolean); }
      catch { /* first sample */ }
      const cutoff = this.#now() - RETENTION_MS;
      lines = lines.filter((line) => {
        try {
          const parsed = JSON.parse(line) as { recordedAt?: unknown };
          return typeof parsed.recordedAt === "number" && parsed.recordedAt >= cutoff;
        } catch { return false; }
      });
      lines.push(JSON.stringify(record));
      while (Buffer.byteLength(`${lines.join("\n")}\n`) > MAX_BYTES && lines.length > 1) lines.shift();
      const temp = `${this.#path}.${process.pid}.tmp`;
      await writeFile(temp, `${lines.join("\n")}\n`, { mode: 0o600 });
      await rename(temp, this.#path);
    }).catch(() => undefined);
  }

  async #readRecords(since: number): Promise<StoredPerformanceRecord[]> {
    let contents = "";
    try { contents = await readFile(this.#path, "utf8"); }
    catch { return []; }
    const records: StoredPerformanceRecord[] = [];
    for (const line of contents.split("\n")) {
      if (!line) continue;
      try {
        const value = JSON.parse(line) as StoredPerformanceRecord;
        if (typeof value.recordedAt !== "number" || value.recordedAt < since) continue;
        if (value.kind !== "turn" && value.kind !== "paint" && value.kind !== "phase") continue;
        records.push(value);
      } catch { /* malformed historical records are ignored */ }
    }
    return records;
  }
}

export function percentiles(input: readonly number[]): PerformancePercentiles {
  const values = input.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!values.length) return { count: 0, p50: 0, p95: 0 };
  return { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 1) return round(values[0]!);
  const position = (values.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return round(values[lower]! + (values[upper]! - values[lower]!) * fraction);
}

function round(value: number): number { return Math.round(value * 10) / 10; }
