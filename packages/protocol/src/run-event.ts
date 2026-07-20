import { z } from "zod";
import { RuntimeIdentifierSchema, UI_EVENT_TYPES } from "./domain.ts";

export const RUN_EVENT_V1_LIMITS = Object.freeze({
  retentionDays: 7,
  maxLedgerBytes: 50 * 1024 * 1024,
  segmentBytes: 1024 * 1024,
  crashTailEvents: 256,
  nameChars: 16 * 1024,
  redactedStringBytes: 4 * 1024,
  redactedContentBytes: 64 * 1024,
  redactedCollectionItems: 32,
  redactedDepth: 6,
  traceRunIdChars: 256,
  traceListItems: 200,
  tracePageEvents: 500,
  traceCorruptions: 100,
} as const);

export const TraceContentPolicyV1Schema = z.enum(["none", "redacted"]);
export type TraceContentPolicyV1 = z.infer<typeof TraceContentPolicyV1Schema>;

/**
 * Fully resolved trace policy. Only `enabled` and `content` are user-facing;
 * the durability and retention constants are versioned protocol invariants.
 */
export const TracePolicyV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    content: TraceContentPolicyV1Schema,
    retentionDays: z.literal(RUN_EVENT_V1_LIMITS.retentionDays),
    maxBytes: z.literal(RUN_EVENT_V1_LIMITS.maxLedgerBytes),
    segmentBytes: z.literal(RUN_EVENT_V1_LIMITS.segmentBytes),
    crashTailEvents: z.literal(RUN_EVENT_V1_LIMITS.crashTailEvents),
  })
  .strict();
export type TracePolicyV1 = z.infer<typeof TracePolicyV1Schema>;

export const DEFAULT_TRACE_POLICY_V1: TracePolicyV1 = Object.freeze({
  schemaVersion: 1,
  enabled: true,
  content: "none",
  retentionDays: RUN_EVENT_V1_LIMITS.retentionDays,
  maxBytes: RUN_EVENT_V1_LIMITS.maxLedgerBytes,
  segmentBytes: RUN_EVENT_V1_LIMITS.segmentBytes,
  crashTailEvents: RUN_EVENT_V1_LIMITS.crashTailEvents,
});

const finite = z.number().finite();
const nonNegative = finite.min(0);
const nonNegativeInteger = z.number().int().nonnegative();
const boundedName = z.string().max(RUN_EVENT_V1_LIMITS.nameChars).refine((value) => !value.includes("\0"));
/** File-safe because run ids are embedded in ledger segment names. */
export const TraceRunIdV1Schema = z
  .string()
  .min(1)
  .max(RUN_EVENT_V1_LIMITS.traceRunIdChars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => value !== "." && value !== "..");
export type TraceRunIdV1 = z.infer<typeof TraceRunIdV1Schema>;
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const optionalCounts = z
  .object({
    chars: nonNegativeInteger.optional(),
    items: nonNegativeInteger.optional(),
    pending: nonNegativeInteger.optional(),
    activities: nonNegativeInteger.optional(),
    jobs: nonNegativeInteger.optional(),
    tasks: nonNegativeInteger.optional(),
    ids: nonNegativeInteger.optional(),
    added: nonNegative.optional(),
    removed: nonNegative.optional(),
    freedTokens: nonNegative.optional(),
    iteration: nonNegative.optional(),
    round: nonNegative.optional(),
    maxRounds: nonNegative.optional(),
    stagnationCount: nonNegative.optional(),
    strategyResets: nonNegative.optional(),
    turns: nonNegative.optional(),
    toolCalls: nonNegative.optional(),
    errors: nonNegative.optional(),
    contextTokens: nonNegative.optional(),
    contextWindow: nonNegative.optional(),
  })
  .strict();

export const RunEventUsageV1Schema = z
  .object({
    inputTokens: nonNegative.optional(),
    outputTokens: nonNegative.optional(),
    totalTokens: nonNegative.optional(),
    cachedInputTokens: nonNegative.optional(),
    cacheWriteTokens: nonNegative.optional(),
    steps: nonNegative.optional(),
    turns: nonNegative.optional(),
    providerLatencyMs: nonNegative.optional(),
    costUSD: nonNegative.optional(),
    actualCostUSD: nonNegative.optional(),
    costEstimated: z.boolean().optional(),
  })
  .strict();

export const RunEventTimingV1Schema = z
  .object({
    durationMs: nonNegative.optional(),
    startedAt: nonNegative.optional(),
    finishedAt: nonNegative.optional(),
    queueDelayMs: nonNegative.optional(),
    hooksMs: nonNegative.optional(),
    checkpointMs: nonNegative.optional(),
    recallMs: nonNegative.optional(),
    attachmentsMs: nonNegative.optional(),
    modelResolveMs: nonNegative.optional(),
    contextPrepareMs: nonNegative.optional(),
    providerTtftMs: nonNegative.optional(),
    firstReasoningMs: nonNegative.optional(),
    firstVisibleTextMs: nonNegative.optional(),
    generationMs: nonNegative.optional(),
    toolMs: nonNegative.optional(),
    persistMs: nonNegative.optional(),
    postTurnMs: nonNegative.optional(),
    totalMs: nonNegative.optional(),
  })
  .strict();

const RUN_EVENT_STATUSES = [
  "inactive",
  "active",
  "pending",
  "in_progress",
  "exit_pending",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
  "exited",
  "killed",
  "approved",
  "denied",
  "resolved",
] as const;

function isBoundedContentValue(value: unknown, depth = 0): boolean {
  if (depth > RUN_EVENT_V1_LIMITS.redactedDepth) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return utf8Bytes(value) <= RUN_EVENT_V1_LIMITS.redactedStringBytes;
  if (Array.isArray(value)) {
    return (
      value.length <= RUN_EVENT_V1_LIMITS.redactedCollectionItems &&
      value.every((item) => isBoundedContentValue(item, depth + 1))
    );
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length <= RUN_EVENT_V1_LIMITS.redactedCollectionItems &&
    entries.every(
      ([key, item]) =>
        key.length <= RUN_EVENT_V1_LIMITS.nameChars &&
        !key.includes("\0") &&
        isBoundedContentValue(item, depth + 1),
    )
  );
}

export const RedactedContentValueV1Schema = z.custom<unknown>(isBoundedContentValue);

/** Named, reviewable content slots. Arbitrary top-level content keys fail. */
export const RunEventContentV1Schema = z
  .object({
    text: RedactedContentValueV1Schema.optional(),
    message: RedactedContentValueV1Schema.optional(),
    label: RedactedContentValueV1Schema.optional(),
    input: RedactedContentValueV1Schema.optional(),
    output: RedactedContentValueV1Schema.optional(),
    diff: RedactedContentValueV1Schema.optional(),
    path: RedactedContentValueV1Schema.optional(),
    command: RedactedContentValueV1Schema.optional(),
    url: RedactedContentValueV1Schema.optional(),
    instruction: RedactedContentValueV1Schema.optional(),
    objective: RedactedContentValueV1Schema.optional(),
    prompt: RedactedContentValueV1Schema.optional(),
    result: RedactedContentValueV1Schema.optional(),
    transcript: RedactedContentValueV1Schema.optional(),
    chunk: RedactedContentValueV1Schema.optional(),
    goal: RedactedContentValueV1Schema.optional(),
    plan: RedactedContentValueV1Schema.optional(),
    question: RedactedContentValueV1Schema.optional(),
    summary: RedactedContentValueV1Schema.optional(),
    error: RedactedContentValueV1Schema.optional(),
  })
  .strict()
  .superRefine((content, ctx) => {
    if (utf8Bytes(JSON.stringify(content)) > RUN_EVENT_V1_LIMITS.redactedContentBytes) {
      ctx.addIssue({ code: "custom", message: "redacted content exceeds byte limit" });
    }
  });
export type RunEventContentV1 = z.infer<typeof RunEventContentV1Schema>;

const uiEventType = z.enum(UI_EVENT_TYPES as [typeof UI_EVENT_TYPES[number], ...typeof UI_EVENT_TYPES[number][]]);

/** Strict, append-only ledger row. Unknown fields are rejected. */
export const RunEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: TraceRunIdV1Schema,
    seq: z.number().int().positive(),
    at: nonNegative,
    type: uiEventType,
    sessionId: RuntimeIdentifierSchema.optional(),
    turnId: RuntimeIdentifierSchema.optional(),
    subagentId: RuntimeIdentifierSchema.optional(),
    taskId: RuntimeIdentifierSchema.optional(),
    toolCallId: RuntimeIdentifierSchema.optional(),
    activityId: RuntimeIdentifierSchema.optional(),
    model: boundedName.optional(),
    mode: z.enum(["plan", "execute"]).optional(),
    toolName: boundedName.optional(),
    agent: boundedName.optional(),
    integration: boundedName.optional(),
    status: z.enum(RUN_EVENT_STATUSES).optional(),
    phase: z.enum(["plan", "execute"]).nullable().optional(),
    outcome: z.enum(["completed", "failed", "cancelled"]).optional(),
    gate: z.enum(["green", "red", "unverified", "aborted"]).optional(),
    action: z.enum(["edit", "write"]).optional(),
    level: z.enum(["info", "warn", "error"]).optional(),
    origin: z.enum(["user", "engine"]).optional(),
    reason: z.enum(["answered", "aborted", "shutdown", "timeout"]).optional(),
    details: z.enum(["quiet", "normal", "verbose"]).optional(),
    target: z.enum(["local", "e2b", "vercel"]).optional(),
    approvalMode: z.enum(["ask", "auto"]).optional(),
    transitions: z
      .array(
        z
          .object({
            kind: z.enum(["activity", "job", "task", "permission", "subagent", "queue"]),
            id: RuntimeIdentifierSchema,
            status: z.enum(RUN_EVENT_STATUSES),
          })
          .strict(),
      )
      .max(RUN_EVENT_V1_LIMITS.redactedCollectionItems)
      .optional(),
    flags: z
      .object({
        isError: z.boolean().optional(),
        active: z.boolean().optional(),
        met: z.boolean().optional(),
        ungrounded: z.boolean().optional(),
        mouse: z.boolean().optional(),
        ok: z.boolean().optional(),
      })
      .strict()
      .optional(),
    counts: optionalCounts.optional(),
    usage: RunEventUsageV1Schema.optional(),
    timing: RunEventTimingV1Schema.optional(),
    content: RunEventContentV1Schema.optional(),
  })
  .strict();
export type RunEventV1 = z.infer<typeof RunEventV1Schema>;

export interface TraceCorruptionV1 {
  segment: string;
  line?: number;
  reason: "invalid-row" | "non-monotonic-sequence" | "sequence-gap";
  detail?: string;
}

export interface TraceSummaryV1 {
  schemaVersion: 1;
  runId: string;
  startedAt: number;
  updatedAt: number;
  firstSeq: number;
  lastSeq: number;
  eventCount: number;
  segmentCount: number;
  hasRedactedContent: boolean;
  corruptionCount: number;
}

export interface TraceListResultV1 {
  schemaVersion: 1;
  traces: TraceSummaryV1[];
  truncated: boolean;
}

export interface TracePageV1 {
  schemaVersion: 1;
  runId: string;
  events: RunEventV1[];
  corruptions: TraceCorruptionV1[];
  lastSeq: number;
  nextAfterSeq: number | null;
  truncated: boolean;
  hasRedactedContent: boolean;
}

const traceRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const traceInteger = (value: unknown, positive = false): value is number =>
  Number.isSafeInteger(value) && (positive ? (value as number) > 0 : (value as number) >= 0);
const traceRunId = (value: unknown): value is string => TraceRunIdV1Schema.safeParse(value).success;
const traceSummary = (value: unknown): value is TraceSummaryV1 => traceRecord(value)
  && value.schemaVersion === 1 && traceRunId(value.runId)
  && typeof value.startedAt === "number" && value.startedAt >= 0
  && typeof value.updatedAt === "number" && value.updatedAt >= 0
  && traceInteger(value.firstSeq, true) && traceInteger(value.lastSeq, true)
  && traceInteger(value.eventCount) && traceInteger(value.segmentCount)
  && typeof value.hasRedactedContent === "boolean" && traceInteger(value.corruptionCount);
const traceCorruption = (value: unknown): value is TraceCorruptionV1 => traceRecord(value)
  && typeof value.segment === "string" && value.segment.length > 0 && value.segment.length <= 512
  && !/[\\/\0]/.test(value.segment)
  && (value.line === undefined || traceInteger(value.line, true))
  && ["invalid-row", "non-monotonic-sequence", "sequence-gap"].includes(value.reason as string)
  && (value.detail === undefined || (typeof value.detail === "string" && value.detail.length <= 1_024));

export const TraceCorruptionV1Schema = z.custom<TraceCorruptionV1>(traceCorruption);
export const TraceSummaryV1Schema = z.custom<TraceSummaryV1>(traceSummary);
export const TraceListResultV1Schema = z.custom<TraceListResultV1>((value) => traceRecord(value)
  && value.schemaVersion === 1 && Array.isArray(value.traces)
  && value.traces.length <= RUN_EVENT_V1_LIMITS.traceListItems && value.traces.every(traceSummary)
  && typeof value.truncated === "boolean");
export const TracePageV1Schema = z.custom<TracePageV1>((value) => traceRecord(value)
  && value.schemaVersion === 1 && traceRunId(value.runId)
  && Array.isArray(value.events) && value.events.length <= RUN_EVENT_V1_LIMITS.tracePageEvents
  && value.events.every((event) => RunEventV1Schema.safeParse(event).success)
  && Array.isArray(value.corruptions) && value.corruptions.length <= RUN_EVENT_V1_LIMITS.traceCorruptions
  && value.corruptions.every(traceCorruption) && traceInteger(value.lastSeq)
  && (value.nextAfterSeq === null || traceInteger(value.nextAfterSeq))
  && typeof value.truncated === "boolean" && typeof value.hasRedactedContent === "boolean");

export function contentFreeRunEventV1(event: RunEventV1): RunEventV1 {
  if (event.content === undefined) return event;
  const { content: _content, ...base } = event;
  return RunEventV1Schema.parse(base);
}
