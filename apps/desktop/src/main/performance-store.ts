import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TurnPerformanceSample } from "../shared/events";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_BYTES = 2 * 1024 * 1024;

interface StoredPerformanceRecord {
  recordedAt: number;
  kind: "turn" | "paint";
  turnId: string;
  sessionId: string;
  sample?: TurnPerformanceSample;
  bridgeDelayMs?: number;
  bridgeToPaintMs?: number;
}

const REQUIRED_DURATION_KEYS = [
  "startedAt", "queueDelayMs", "hooksMs", "checkpointMs", "recallMs",
  "attachmentsMs", "modelResolveMs", "contextPrepareMs", "generationMs",
  "toolMs", "persistMs", "postTurnMs", "totalMs",
] as const;
const OPTIONAL_NUMBER_KEYS = [
  "providerTtftMs", "firstReasoningMs", "firstVisibleTextMs", "inputTokens", "cachedInputTokens", "outputTokens",
] as const;

function sanitizeSample(value: unknown): TurnPerformanceSample | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (
    typeof input.turnId !== "string" || typeof input.sessionId !== "string" ||
    typeof input.model !== "string" ||
    (input.serviceTier !== "default" && input.serviceTier !== "priority") ||
    REQUIRED_DURATION_KEYS.some((key) => typeof input[key] !== "number" || !Number.isFinite(input[key]))
  ) return undefined;
  const sample = {
    turnId: input.turnId, sessionId: input.sessionId, model: input.model,
    serviceTier: input.serviceTier,
  } as TurnPerformanceSample;
  for (const key of REQUIRED_DURATION_KEYS) sample[key] = input[key] as number;
  for (const key of OPTIONAL_NUMBER_KEYS) {
    if (typeof input[key] === "number" && Number.isFinite(input[key])) sample[key] = input[key] as number;
  }
  return sample;
}

export class PerformanceStore {
  readonly #path: string;
  #writeTail: Promise<void> = Promise.resolve();
  #activeTurn = new Map<string, string>();
  #firstDeltaAt = new Map<string, number>();

  constructor(userData: string) { this.#path = join(userData, "performance", "turns.jsonl"); }

  observeEngineEvent(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const value = event as { type?: unknown; sessionId?: unknown; turnId?: unknown; subagentId?: unknown; sample?: unknown };
    if (typeof value.sessionId !== "string") return;
    if (value.type === "user-message" && typeof value.turnId === "string") { this.#activeTurn.set(value.sessionId, value.turnId); return; }
    if (value.type === "assistant-text-delta" && value.subagentId === undefined) {
      const turnId = this.#activeTurn.get(value.sessionId);
      if (turnId && !this.#firstDeltaAt.has(turnId)) this.#firstDeltaAt.set(turnId, Date.now());
      return;
    }
    if (value.type !== "turn-performance") return;
    const sample = sanitizeSample(value.sample);
    if (!sample || typeof sample.turnId !== "string" || sample.sessionId !== value.sessionId) return;
    const receivedAt = Date.now();
    this.#append({ recordedAt: receivedAt, kind: "turn", turnId: sample.turnId, sessionId: sample.sessionId, sample, bridgeDelayMs: Math.max(0, receivedAt - (sample.startedAt + sample.totalMs)) });
    this.#activeTurn.delete(value.sessionId);
  }

  recordFirstPaint(input: { turnId: string; sessionId: string; paintedAt: number }): void {
    const firstDeltaAt = this.#firstDeltaAt.get(input.turnId);
    if (firstDeltaAt === undefined) return;
    this.#firstDeltaAt.delete(input.turnId);
    this.#append({ recordedAt: Date.now(), kind: "paint", turnId: input.turnId, sessionId: input.sessionId, bridgeToPaintMs: Math.max(0, input.paintedAt - firstDeltaAt) });
  }

  flush(): Promise<void> { return this.#writeTail; }

  #append(record: StoredPerformanceRecord): void {
    this.#writeTail = this.#writeTail.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      let lines: string[] = [];
      try { lines = (await readFile(this.#path, "utf8")).split("\n").filter(Boolean); } catch { /* first sample */ }
      const cutoff = Date.now() - RETENTION_MS;
      lines = lines.filter((line) => { try { const parsed = JSON.parse(line) as { recordedAt?: unknown }; return typeof parsed.recordedAt === "number" && parsed.recordedAt >= cutoff; } catch { return false; } });
      lines.push(JSON.stringify(record));
      while (Buffer.byteLength(`${lines.join("\n")}\n`) > MAX_BYTES && lines.length > 1) lines.shift();
      const temp = `${this.#path}.${process.pid}.tmp`;
      await writeFile(temp, `${lines.join("\n")}\n`, { mode: 0o600 });
      await rename(temp, this.#path);
    }).catch(() => undefined);
  }
}
