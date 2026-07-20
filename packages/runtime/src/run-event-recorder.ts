import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { globalStateDir, registerCrashRunEventTail } from "@vibe/core";
import {
  DEFAULT_TRACE_POLICY_V1,
  RUN_EVENT_V1_LIMITS,
  RunEventV1Schema,
  TracePolicyV1Schema,
  contentFreeRunEventV1,
  type RunEventContentV1,
  type RunEventV1,
  type TraceContentPolicyV1,
  type TracePolicyV1,
} from "@vibe/protocol";
import type { UIEvent } from "@vibe/shared";

const SECRET_KEY_RE = /api[-_]?key|token|authorization|secret|password|cookie/i;
const SECRET_INLINE_RE =
  /((?:api[-_]?key|token|authorization|secret|password|cookie)["'\s]*[:=]["'\s]*)([^\s"',]+)/gi;
const BEARER_RE = /(bearer\s+)(\S+)/gi;
const SECRET_TOKEN_RE = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abpr])[_-][A-Za-z0-9][A-Za-z0-9_-]{9,}\b/g;
const GOOGLE_KEY_RE = /\bAIza[0-9A-Za-z_-]{20,}\b/g;
const TERMINAL_EVENTS = new Set<UIEvent["type"]>([
  "turn-finished",
  "session-idle",
  "engine-idle",
  "engine-error",
]);

export function resolvedTracePolicyV1(
  config: { enabled?: boolean; content?: TraceContentPolicyV1 } | undefined,
): TracePolicyV1 {
  return TracePolicyV1Schema.parse({
    ...DEFAULT_TRACE_POLICY_V1,
    enabled: config?.enabled ?? DEFAULT_TRACE_POLICY_V1.enabled,
    content: config?.content ?? DEFAULT_TRACE_POLICY_V1.content,
  });
}

export function runEventLedgerDir(cwd: string): string {
  return join(globalStateDir(cwd), "run-events");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const suffix = "…[truncated]";
  const suffixBytes = utf8Bytes(suffix);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, mid)) + suffixBytes <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

function redactString(value: string): string {
  return truncateUtf8(
    value
      .replace(BEARER_RE, "$1***")
      .replace(SECRET_INLINE_RE, "$1***")
      .replace(SECRET_TOKEN_RE, "***")
      .replace(GOOGLE_KEY_RE, "***"),
    RUN_EVENT_V1_LIMITS.redactedStringBytes,
  );
}

/** Immutable, deterministic, cycle/binary/BigInt-safe redaction for opt-in content. */
export function redactTraceValue(value: unknown): unknown {
  const ancestors = new WeakSet<object>();
  const visit = (input: unknown, depth: number): unknown => {
    if (typeof input === "string") return redactString(input);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : String(input);
    if (typeof input === "bigint") return `${input.toString()}n`;
    if (typeof input === "undefined") return "[Undefined]";
    if (typeof input === "symbol") return `[Symbol ${redactString(input.description ?? "")}]`;
    if (typeof input === "function") return "[Function]";
    if (!input || typeof input !== "object") return redactString(String(input));
    if (ArrayBuffer.isView(input)) return `[Binary ${input.byteLength} bytes]`;
    if (input instanceof ArrayBuffer) return `[Binary ${input.byteLength} bytes]`;
    if (input instanceof Date) return input.toISOString();
    if (depth >= RUN_EVENT_V1_LIMITS.redactedDepth) return "[Truncated depth]";
    if (ancestors.has(input)) return "[Circular]";
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        return input
          .slice(0, RUN_EVENT_V1_LIMITS.redactedCollectionItems)
          .map((item) => visit(item, depth + 1));
      }
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input).slice(
        0,
        RUN_EVENT_V1_LIMITS.redactedCollectionItems,
      )) {
        const safeKey = truncateUtf8(key.replaceAll("\0", ""), RUN_EVENT_V1_LIMITS.nameChars);
        out[safeKey] = SECRET_KEY_RE.test(key) ? "***" : visit(item, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(input);
    }
  };
  return visit(value, 0);
}

function boundedContent(fields: Record<string, unknown>): RunEventContentV1 | undefined {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const redacted = redactTraceValue(value);
    const candidate = { ...content, [key]: redacted };
    if (utf8Bytes(JSON.stringify(candidate)) <= RUN_EVENT_V1_LIMITS.redactedContentBytes) {
      content[key] = redacted;
    } else {
      content[key] = "[Truncated byte limit]";
      if (utf8Bytes(JSON.stringify(content)) > RUN_EVENT_V1_LIMITS.redactedContentBytes) {
        delete content[key];
      }
    }
  }
  return Object.keys(content).length > 0 ? (content as RunEventContentV1) : undefined;
}

interface ProjectionState {
  sessionId?: string;
  turnId?: string;
  model?: string;
  mode?: "plan" | "execute";
  toolStartedAt: Map<string, number>;
}

function copyUsage(usage: Record<string, unknown> | undefined): RunEventV1["usage"] {
  if (!usage) return undefined;
  const fields = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "steps",
    "turns",
    "providerLatencyMs",
    "costUSD",
    "actualCostUSD",
  ] as const;
  const out: Record<string, number | boolean> = {};
  for (const field of fields) {
    const value = usage[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[field] = value;
  }
  if (typeof usage.costEstimated === "boolean") out.costEstimated = usage.costEstimated;
  return Object.keys(out).length > 0 ? (out as RunEventV1["usage"]) : undefined;
}

function copyMetrics(metrics: Record<string, unknown> | undefined): RunEventV1["counts"] {
  if (!metrics) return undefined;
  const out: NonNullable<RunEventV1["counts"]> = {};
  if (typeof metrics.turns === "number") out.turns = metrics.turns;
  if (typeof metrics.toolCalls === "number") out.toolCalls = metrics.toolCalls;
  if (typeof metrics.errors === "number") out.errors = metrics.errors;
  if (typeof metrics.contextTokens === "number") out.contextTokens = metrics.contextTokens;
  if (typeof metrics.contextWindow === "number") out.contextWindow = metrics.contextWindow;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Project one raw UI event into the sole canonical runtime-ledger row. */
export function projectRunEventV1(
  event: UIEvent,
  input: {
    runId: string;
    seq: number;
    at: number;
    content: TraceContentPolicyV1;
    state?: ProjectionState;
  },
): RunEventV1 {
  const state: ProjectionState = input.state ?? { toolStartedAt: new Map() };
  const raw = event as UIEvent & Record<string, unknown>;
  if (event.type === "session-start") {
    state.sessionId = event.sessionId;
    state.model = event.model;
    state.mode = event.mode;
  } else {
    if (typeof raw.sessionId === "string") state.sessionId = raw.sessionId;
    if (event.type === "model-changed") state.model = event.model;
    if (event.type === "mode-changed") state.mode = event.mode;
  }
  if (event.type === "user-message" && event.turnId) state.turnId = event.turnId;
  if (event.type === "turn-performance") state.turnId = event.sample.turnId;

  const row: Record<string, unknown> = {
    schemaVersion: 1,
    runId: input.runId,
    seq: input.seq,
    at: input.at,
    type: event.type,
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(state.turnId ? { turnId: state.turnId } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.mode ? { mode: state.mode } : {}),
  };
  for (const key of ["subagentId", "taskId", "toolCallId"] as const) {
    if (typeof raw[key] === "string") row[key] = raw[key];
  }
  const content: Record<string, unknown> = {};

  switch (event.type) {
    case "session-start":
      break;
    case "user-message":
      row.origin = event.origin;
      row.counts = { chars: event.text.length };
      content.text = event.text;
      content.label = event.label;
      break;
    case "assistant-text-delta":
    case "reasoning-delta":
      row.counts = { chars: event.delta.length };
      content.text = event.delta;
      break;
    case "tool-call-started":
      row.toolName = event.toolName;
      state.toolStartedAt.set(event.toolCallId, input.at);
      content.input = event.input;
      break;
    case "tool-call-progress":
      row.counts = { chars: event.chunk.length };
      content.chunk = event.chunk;
      break;
    case "tool-call-finished": {
      row.toolName = event.toolName;
      row.flags = { isError: event.isError };
      const startedAt = state.toolStartedAt.get(event.toolCallId);
      if (startedAt !== undefined) row.timing = { durationMs: Math.max(0, input.at - startedAt) };
      state.toolStartedAt.delete(event.toolCallId);
      content.output = event.output;
      break;
    }
    case "step-finished":
      row.usage = copyUsage(event.usage as Record<string, unknown> | undefined);
      break;
    case "usage-updated":
      row.usage = copyUsage(event.usage as unknown as Record<string, unknown>);
      break;
    case "context-updated":
      row.counts = { contextTokens: event.usedTokens, contextWindow: event.contextWindow };
      break;
    case "mode-changed":
    case "model-changed":
      break;
    case "goal-changed":
      row.flags = { active: event.goal !== null };
      content.goal = event.goal;
      break;
    case "goal-run":
      row.phase = event.run.phase;
      row.flags = { active: event.run.active, met: event.run.met };
      row.counts = {
        round: event.run.round,
        maxRounds: event.run.max,
        ...(event.run.stagnationCount === undefined ? {} : { stagnationCount: event.run.stagnationCount }),
        ...(event.run.strategyResets === undefined ? {} : { strategyResets: event.run.strategyResets }),
      };
      break;
    case "plan-state-changed":
      row.status = event.state.status;
      row.flags = { ungrounded: event.state.ungrounded ?? false };
      content.plan = event.state.plan;
      break;
    case "question-request":
      row.activityId = event.question.id;
      row.counts = { items: event.question.choices.length };
      content.question = event.question;
      break;
    case "question-settled":
      row.activityId = event.id;
      row.reason = event.reason;
      break;
    case "activities-changed":
      row.counts = { activities: event.activities.length };
      row.transitions = event.activities
        .slice(0, RUN_EVENT_V1_LIMITS.redactedCollectionItems)
        .map((activity) => ({ kind: "activity", id: activity.id, status: activity.status }));
      break;
    case "theme-changed":
    case "accent-changed":
      break;
    case "details-changed":
      row.details = event.details;
      break;
    case "mouse-changed":
      row.flags = { mouse: event.mouse };
      break;
    case "git-updated":
      break;
    case "jobs-changed":
      row.counts = { jobs: event.jobs.length };
      row.transitions = event.jobs
        .slice(0, RUN_EVENT_V1_LIMITS.redactedCollectionItems)
        .map((job) => ({ kind: "job", id: job.id, status: job.status }));
      break;
    case "approvals-changed":
      row.approvalMode = event.mode;
      break;
    case "plan-presented":
      row.flags = { ungrounded: event.ungrounded ?? false };
      row.counts = { items: (event.sources?.length ?? 0) + (event.assumptions?.length ?? 0) };
      content.plan = event.plan;
      break;
    case "permission-request":
      row.activityId = event.id;
      row.toolName = event.toolName;
      row.transitions = [{ kind: "permission", id: event.id, status: "pending" }];
      content.input = event.input;
      break;
    case "permission-settled":
      row.counts = { ids: event.ids.length };
      row.reason = event.reason;
      row.transitions = event.ids
        .slice(0, RUN_EVENT_V1_LIMITS.redactedCollectionItems)
        .map((id) => ({ kind: "permission", id, status: "cancelled" }));
      break;
    case "tasks-updated":
      row.counts = { tasks: event.tasks.length };
      row.transitions = event.tasks
        .slice(0, RUN_EVENT_V1_LIMITS.redactedCollectionItems)
        .map((task) => ({ kind: "task", id: task.id, status: task.status }));
      break;
    case "orchestration-task":
      row.status = event.status;
      row.counts = event.attempts === undefined ? undefined : { items: event.attempts };
      row.timing = event.durationMs === undefined ? undefined : { durationMs: event.durationMs };
      content.objective = event.objective;
      break;
    case "queue-changed":
      row.counts = { pending: event.pending.length, items: event.pending.length + (event.active ? 1 : 0) };
      row.transitions = [
        ...(event.active ? [{ kind: "queue" as const, id: event.active.id, status: "running" as const }] : []),
        ...event.pending
          .slice(0, RUN_EVENT_V1_LIMITS.redactedCollectionItems - (event.active ? 1 : 0))
          .map((item) => ({ kind: "queue" as const, id: item.id, status: "queued" as const })),
      ];
      break;
    case "file-changed":
      row.action = event.action;
      row.counts = { added: event.added, removed: event.removed };
      content.path = event.path;
      content.diff = event.diff;
      break;
    case "checkpoint-created":
    case "checkpoint-restored":
      row.activityId = event.id;
      content.label = event.label;
      break;
    case "verify-started":
      content.command = event.command;
      break;
    case "verify-finished":
      row.flags = { ok: event.ok };
      content.output = event.output;
      break;
    case "compacted":
      row.counts = { freedTokens: event.freedTokens };
      break;
    case "runtime-handoff-requested":
      row.target = event.target.kind === "local" ? "local" : event.target.provider;
      content.instruction = event.instruction;
      break;
    case "external-capability-pending":
      row.activityId = event.request.id;
      row.integration = event.request.integration;
      row.toolName = event.request.toolName;
      row.status = event.request.status;
      content.input = event.request.arguments;
      content.result = event.request.result;
      content.error = event.request.error;
      break;
    case "external-capability-resolved":
      row.activityId = event.id;
      row.status = event.status;
      break;
    case "subagent-started":
      row.agent = event.agent;
      row.transitions = [{ kind: "subagent", id: event.subagentId, status: "running" }];
      row.timing = event.startedAt === undefined ? undefined : { startedAt: event.startedAt };
      content.prompt = event.prompt;
      break;
    case "subagent-activity":
      row.counts = copyMetrics(event.metrics as Record<string, unknown> | undefined);
      row.usage = copyUsage(event.metrics as Record<string, unknown> | undefined);
      content.label = event.label;
      content.transcript = event.transcriptDelta;
      break;
    case "subagent-finished":
      row.counts = copyMetrics(event.metrics as Record<string, unknown> | undefined);
      row.usage = copyUsage(event.metrics as Record<string, unknown> | undefined);
      row.transitions = [{ kind: "subagent", id: event.subagentId, status: "completed" }];
      row.timing = event.finishedAt === undefined ? undefined : { finishedAt: event.finishedAt };
      content.result = event.result;
      content.transcript = event.transcript;
      break;
    case "loop-tick":
      row.activityId = event.loopId;
      row.counts = { iteration: event.iteration };
      break;
    case "loop-stopped":
      row.activityId = event.loopId;
      content.message = event.reason;
      break;
    case "notice":
      row.level = event.level;
      content.message = event.message;
      break;
    case "engine-error":
      content.error = event.message;
      break;
    case "turn-performance": {
      const sample = event.sample;
      row.model = sample.model;
      row.outcome = sample.outcome;
      row.usage = copyUsage(sample as unknown as Record<string, unknown>);
      row.timing = {
        startedAt: sample.startedAt,
        queueDelayMs: sample.queueDelayMs,
        hooksMs: sample.hooksMs,
        checkpointMs: sample.checkpointMs,
        recallMs: sample.recallMs,
        attachmentsMs: sample.attachmentsMs,
        modelResolveMs: sample.modelResolveMs,
        contextPrepareMs: sample.contextPrepareMs,
        providerTtftMs: sample.providerTtftMs,
        firstReasoningMs: sample.firstReasoningMs,
        firstVisibleTextMs: sample.firstVisibleTextMs,
        generationMs: sample.generationMs,
        toolMs: sample.toolMs,
        persistMs: sample.persistMs,
        postTurnMs: sample.postTurnMs,
        totalMs: sample.totalMs,
      };
      break;
    }
    case "engine-idle":
      row.gate = event.gate;
      break;
    case "turn-finished":
    case "session-idle":
      break;
  }

  if (input.content === "redacted") {
    const safeContent = boundedContent(content);
    if (safeContent) row.content = safeContent;
  }
  const parsed = RunEventV1Schema.parse(row);
  if (event.type === "engine-idle") state.turnId = undefined;
  return parsed;
}

export interface RuntimeEventRecorder {
  observe(event: UIEvent): void;
  close(): Promise<void>;
  crashTail(): readonly RunEventV1[];
}

export interface RunEventRecorderOptions {
  directory: string;
  policy?: TracePolicyV1;
  runId?: string;
  now?: () => number;
}

export class RunEventRecorder implements RuntimeEventRecorder {
  readonly #directory: string;
  readonly #policy: TracePolicyV1;
  readonly #runId: string;
  readonly #now: () => number;
  readonly #state: ProjectionState = { toolStartedAt: new Map() };
  readonly #tail: RunEventV1[] = [];
  readonly #unregisterCrashTail: () => void;
  #seq = 0;
  #segment = 0;
  #segmentBytes = 0;
  #handle: FileHandle | undefined;
  #closed = false;
  #writeChain: Promise<void>;

  constructor(options: RunEventRecorderOptions) {
    this.#directory = options.directory;
    this.#policy = TracePolicyV1Schema.parse(options.policy ?? DEFAULT_TRACE_POLICY_V1);
    this.#runId = options.runId ?? randomUUID();
    this.#now = options.now ?? Date.now;
    this.#writeChain = this.#policy.enabled ? this.#initialize().catch(() => undefined) : Promise.resolve();
    this.#unregisterCrashTail = registerCrashRunEventTail(() => this.#tail);
  }

  observe(event: UIEvent): void {
    if (this.#closed) return;
    const seq = ++this.#seq;
    let projected: RunEventV1;
    try {
      projected = projectRunEventV1(event, {
        runId: this.#runId,
        seq,
        at: this.#now(),
        content: this.#policy.content,
        state: this.#state,
      });
    } catch {
      projected = RunEventV1Schema.parse({
        schemaVersion: 1,
        runId: this.#runId,
        seq,
        at: this.#now(),
        type: event.type,
      });
    }
    const contentFree = contentFreeRunEventV1(projected);
    this.#tail.push(contentFree);
    if (this.#tail.length > this.#policy.crashTailEvents) this.#tail.shift();
    if (!this.#policy.enabled) return;
    const terminal = TERMINAL_EVENTS.has(event.type);
    this.#writeChain = this.#writeChain
      .then(() => this.#append(projected, terminal))
      .catch(() => undefined);
  }

  crashTail(): readonly RunEventV1[] {
    return this.#tail.map((event) => ({ ...event }));
  }

  async close(): Promise<void> {
    if (this.#closed) return this.#writeChain;
    this.#closed = true;
    await this.#writeChain;
    if (this.#handle) {
      await this.#handle.sync().catch(() => undefined);
      await this.#handle.close().catch(() => undefined);
      this.#handle = undefined;
    }
    await enforceRunEventRetention(this.#directory, this.#policy).catch(() => undefined);
    this.#unregisterCrashTail();
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await recoverRunEventLedger(this.#directory);
    await enforceRunEventRetention(this.#directory, this.#policy);
  }

  async #append(event: RunEventV1, sync: boolean): Promise<void> {
    const line = `${JSON.stringify(RunEventV1Schema.parse(event))}\n`;
    const bytes = utf8Bytes(line);
    if (!this.#handle || this.#segmentBytes + bytes > this.#policy.segmentBytes) {
      if (this.#handle) {
        await this.#handle.sync();
        await this.#handle.close();
        this.#handle = undefined;
        await enforceRunEventRetention(this.#directory, this.#policy).catch(() => undefined);
      }
      this.#segment += 1;
      const path = join(
        this.#directory,
        `${this.#runId}-${String(this.#segment).padStart(6, "0")}.jsonl`,
      );
      this.#handle = await open(path, "a", 0o600);
      await chmod(path, 0o600);
      this.#segmentBytes = (await this.#handle.stat()).size;
    }
    await this.#handle.write(line, undefined, "utf8");
    this.#segmentBytes += bytes;
    if (sync) await this.#handle.sync();
  }
}

async function ledgerFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

async function atomicRewrite(path: string, bytes: Uint8Array): Promise<void> {
  const temp = join(
    path.slice(0, path.length - basename(path).length),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temp, bytes, { mode: 0o600 });
    const handle = await open(temp, "r");
    await handle.sync();
    await handle.close();
    await rename(temp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Repair each segment to its longest newline-terminated, schema-valid prefix. */
export async function recoverRunEventLedger(directory: string): Promise<void> {
  for (const path of await ledgerFiles(directory)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      continue;
    }
    let offset = 0;
    let validEnd = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) break;
      const line = bytes.subarray(offset, newline).toString("utf8");
      try {
        if (line.length > 0) RunEventV1Schema.parse(JSON.parse(line));
        validEnd = newline + 1;
        offset = newline + 1;
      } catch {
        break;
      }
    }
    if (validEnd !== bytes.length) {
      await atomicRewrite(path, bytes.subarray(0, validEnd)).catch(() => undefined);
    } else {
      await chmod(path, 0o600).catch(() => undefined);
    }
  }
}

async function trimOldestPrefix(path: string, removeAtLeast: number): Promise<number> {
  const bytes = await readFile(path);
  let cut = Math.min(removeAtLeast, bytes.length);
  while (cut < bytes.length && bytes[cut - 1] !== 0x0a) cut += 1;
  await atomicRewrite(path, bytes.subarray(cut));
  return cut;
}

/** Prune expired segments, then enforce the global cap oldest-first. */
export async function enforceRunEventRetention(
  directory: string,
  policy: TracePolicyV1 = DEFAULT_TRACE_POLICY_V1,
  nowMs = Date.now(),
): Promise<void> {
  const cutoff = nowMs - policy.retentionDays * 24 * 60 * 60 * 1000;
  const entries: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const path of await ledgerFiles(directory)) {
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoff) {
        await unlink(path).catch(() => undefined);
      } else {
        entries.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      }
    } catch {
      // Concurrent cleanup is harmless.
    }
  }
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  while (total > policy.maxBytes && entries.length > 0) {
    const oldest = entries[0]!;
    const excess = total - policy.maxBytes;
    if (oldest.size <= excess) {
      await unlink(oldest.path).catch(() => undefined);
      total -= oldest.size;
      entries.shift();
      continue;
    }
    const removed = await trimOldestPrefix(oldest.path, excess).catch(() => 0);
    total -= removed;
    break;
  }
}
