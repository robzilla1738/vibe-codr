import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentContext, SessionUpdate } from "@agentclientprotocol/sdk";
import { type PersistedSession, type SessionMeta, SessionStore } from "@vibe/core";
import {
  ACP_VIBE_METHODS,
  API_V1_CAPABILITIES,
  API_V1_COMMAND_TYPES,
  API_V1_LIMITS,
  ApiV1DecisionReceiptSchema,
  ApiV1SseEventSchema,
  ApiV1SseReadySchema,
  VibeAcpCapabilitiesRequestSchema,
  VibeAcpCapabilitiesResponseSchema,
  VibeAcpCommandRequestSchema,
  VibeAcpCommandResponseSchema,
  VibeAcpDecisionRequestSchema,
  VibeAcpDecisionResponseSchema,
  VibeAcpReplayRequestSchema,
  VibeAcpReplayResponseSchema,
  VibeAcpSnapshotRequestSchema,
  VibeAcpSnapshotResponseSchema,
  type ApiV1Cursor,
  type ApiV1Decision,
  type ApiV1DecisionReceipt,
  type ApiV1SseFrame,
} from "@vibe/protocol";
import { openRuntimeSession } from "@vibe/runtime";
import type { EngineCommand, EngineSnapshot, Mode, UIEvent } from "@vibe/shared";
import { ACP_STDIO_LIMITS, boundedNdJsonStream } from "./bounded-stream.ts";

export interface AcpRuntime {
  events(): AsyncIterable<UIEvent>;
  send(command: EngineCommand): Promise<void> | void;
  snapshot(): EngineSnapshot;
  close(): Promise<void>;
}

export interface AcpSessionStore {
  list(): Promise<SessionMeta[]>;
  load(id: string): Promise<PersistedSession | null>;
  fork(id: string, atTurnId: string): Promise<SessionMeta>;
  delete(id: string): Promise<boolean>;
}

export interface RunAcpStdioOptions {
  cwd: string;
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  maxFrameBytes?: number;
  maxPendingRequests?: number;
  shutdownMs?: number;
  dependencies?: {
    store?: AcpSessionStore;
    openRuntime?: (input: {
      cwd: string;
      resume: { kind: "new" } | { kind: "loaded"; session: PersistedSession };
      mode?: Mode;
    }) => Promise<AcpRuntime>;
  };
}

type PendingKind = ApiV1Decision["kind"];
type StoredReceipt = { digest: string; receipt: ApiV1DecisionReceipt };
type StoredFrame = Extract<ApiV1SseFrame, { type: "event" }> & { bytes: number };

class RuntimeSlot {
  readonly pending = new Map<string, PendingKind>();
  readonly receipts = new Map<string, StoredReceipt>();
  readonly #frames: StoredFrame[] = [];
  #replayBytes = 0;
  #closed = false;
  #promptWaiter:
    | { resolve: (reason: "end_turn" | "cancelled" | "refusal") => void; cancelled: boolean }
    | undefined;

  constructor(
    readonly runtime: AcpRuntime,
    readonly epoch: string,
    readonly nextSequence: () => number,
    readonly sendUpdate: (sessionId: string, update: SessionUpdate) => Promise<void>,
  ) {
    void this.#consume();
  }

  get sessionId(): string {
    return this.runtime.snapshot().sessionId;
  }

  async prompt(text: string): Promise<"end_turn" | "cancelled" | "refusal"> {
    if (this.#promptWaiter) throw new Error("session already has an active prompt");
    const result = new Promise<"end_turn" | "cancelled" | "refusal">((resolve) => {
      this.#promptWaiter = { resolve, cancelled: false };
    });
    try {
      await this.runtime.send({ type: "submit-prompt", text });
    } catch (error) {
      this.#promptWaiter = undefined;
      throw error;
    }
    return result;
  }

  async cancel(): Promise<void> {
    if (this.#promptWaiter) this.#promptWaiter.cancelled = true;
    await this.runtime.send({ type: "abort" });
  }

  async #consume(): Promise<void> {
    try {
      for await (const event of this.runtime.events()) {
        if (this.#closed) break;
        const sequence = this.nextSequence();
        const pendingDecisionId = this.#observePending(event, sequence);
        const parsed = ApiV1SseEventSchema.parse({
          type: "event",
          cursor: { epoch: this.epoch, sequence },
          event,
          ...(pendingDecisionId ? { pendingDecisionId } : {}),
        });
        const bytes = Buffer.byteLength(JSON.stringify(parsed));
        this.#frames.push({ ...parsed, bytes });
        this.#replayBytes += bytes;
        while (
          this.#frames.length > API_V1_LIMITS.replayFrames ||
          this.#replayBytes > API_V1_LIMITS.replayBytes
        ) {
          const removed = this.#frames.shift();
          if (removed) this.#replayBytes -= removed.bytes;
        }
        const update = eventToSessionUpdate(event, pendingDecisionId);
        if (update) await this.sendUpdate(this.sessionId, update);
        if (event.type === "engine-idle") this.#resolvePrompt();
        if (event.type === "engine-error") this.#resolvePrompt("refusal");
      }
    } catch {
      this.#resolvePrompt("refusal");
    }
  }

  #resolvePrompt(fallback: "end_turn" | "refusal" = "end_turn"): void {
    const waiter = this.#promptWaiter;
    this.#promptWaiter = undefined;
    if (waiter) waiter.resolve(waiter.cancelled ? "cancelled" : fallback);
  }

  #observePending(event: UIEvent, sequence: number): string | undefined {
    if (event.type === "permission-request") {
      this.pending.set(event.id, "permission");
      return event.id;
    }
    if (event.type === "permission-settled") for (const id of event.ids) this.pending.delete(id);
    if (event.type === "question-request") {
      this.pending.set(event.question.id, "question");
      return event.question.id;
    }
    if (event.type === "question-settled") this.pending.delete(event.id);
    if (event.type === "external-capability-pending") {
      this.pending.set(event.request.id, "external-capability");
      return event.request.id;
    }
    if (event.type === "external-capability-resolved") this.pending.delete(event.id);
    if (event.type === "plan-presented") {
      for (const [id, kind] of this.pending) if (kind === "plan") this.pending.delete(id);
      const id = `plan-${sequence}`;
      this.pending.set(id, "plan");
      return id;
    }
    if (event.type === "plan-state-changed" && event.state.status !== "pending") {
      for (const [id, kind] of this.pending) if (kind === "plan") this.pending.delete(id);
    }
    return undefined;
  }

  replay(cursor?: ApiV1Cursor): ApiV1SseFrame[] {
    const currentSequence = this.#frames.at(-1)?.cursor.sequence ?? 0;
    const firstSequence = this.#frames[0]?.cursor.sequence;
    const truncated = Boolean(
      cursor &&
        (cursor.epoch !== this.epoch ||
          cursor.sequence > currentSequence ||
          (cursor.sequence < currentSequence &&
            (firstSequence === undefined || cursor.sequence < firstSequence - 1))),
    );
    const ready = ApiV1SseReadySchema.parse({
      type: "ready",
      cursor: { epoch: this.epoch, sequence: currentSequence },
      truncated,
      ...(truncated ? { snapshot: this.runtime.snapshot() } : {}),
    });
    const replayed = cursor && !truncated
      ? this.#frames.filter((frame) => frame.cursor.sequence > cursor.sequence).map(stripBytes)
      : [];
    return [ready, ...replayed];
  }

  async decide(input: { idempotencyKey: string; decision: ApiV1Decision }): Promise<ApiV1DecisionReceipt> {
    const digest = createHash("sha256").update(JSON.stringify(input.decision)).digest("hex");
    const stored = this.receipts.get(input.idempotencyKey);
    if (stored) {
      if (stored.digest !== digest) throw new Error("idempotency key was used with another decision");
      return stored.receipt;
    }
    if (this.pending.get(input.decision.id) !== input.decision.kind) {
      throw new Error("pending decision does not exist or is stale");
    }
    const receipt = ApiV1DecisionReceiptSchema.parse({
      receiptId: `rcpt-${randomUUID()}`,
      idempotencyKey: input.idempotencyKey,
      sessionId: this.sessionId,
      pendingId: input.decision.id,
      acceptedAt: Date.now(),
    });
    this.pending.delete(input.decision.id);
    this.receipts.set(input.idempotencyKey, { digest, receipt });
    try {
      await this.runtime.send(decisionCommand(input.decision));
      return receipt;
    } catch (error) {
      this.receipts.delete(input.idempotencyKey);
      this.pending.set(input.decision.id, input.decision.kind);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#resolvePrompt("refusal");
    await this.runtime.close();
  }
}

class AcpWorkspace {
  readonly cwd: string;
  readonly epoch = randomBytes(16).toString("hex");
  readonly #store: AcpSessionStore;
  readonly #openRuntime: NonNullable<NonNullable<RunAcpStdioOptions["dependencies"]>["openRuntime"]>;
  readonly #slots = new Map<string, RuntimeSlot>();
  #sequence = 0;
  client: AgentContext | undefined;

  constructor(options: RunAcpStdioOptions) {
    this.cwd = resolve(options.cwd);
    this.#store = options.dependencies?.store ?? new SessionStore(this.cwd);
    this.#openRuntime = options.dependencies?.openRuntime ?? (async ({ cwd, resume, mode }) =>
      openRuntimeSession({ cwd, interactive: true, resume, ...(mode ? { modeOverride: mode } : {}) }));
  }

  assertLocal(input: { cwd: string; mcpServers?: unknown[]; additionalDirectories?: string[] }): void {
    if (resolve(input.cwd) !== this.cwd) throw new Error("ACP workspace transfer is not supported");
    if (input.mcpServers?.length) throw new Error("ACP MCP transfer is not supported");
    if (input.additionalDirectories?.length) throw new Error("additional workspace roots are not supported");
  }

  async create(): Promise<RuntimeSlot> {
    return this.#attach(await this.#openRuntime({ cwd: this.cwd, resume: { kind: "new" } }));
  }

  async active(id: string): Promise<RuntimeSlot> {
    const active = this.#slots.get(id);
    if (active) return active;
    const session = await this.#store.load(id);
    if (!session) throw new Error(`session not found: ${id}`);
    return this.#attach(await this.#openRuntime({ cwd: this.cwd, resume: { kind: "loaded", session } }));
  }

  #attach(runtime: AcpRuntime): RuntimeSlot {
    const slot = new RuntimeSlot(runtime, this.epoch, () => ++this.#sequence, async (sessionId, update) => {
      if (this.client) await this.client.notify("session/update", { sessionId, update });
    });
    this.#slots.set(slot.sessionId, slot);
    return slot;
  }

  async list() {
    return (await this.#store.list()).map((meta) => ({
      sessionId: meta.id,
      cwd: this.cwd,
      ...(meta.title ? { title: meta.title } : {}),
      updatedAt: new Date(meta.updatedAt).toISOString(),
    }));
  }

  async fork(id: string): Promise<SessionMeta> {
    const loaded = await this.#store.load(id);
    const turnId = loaded?.meta.turns?.at(-1)?.id;
    if (!turnId) throw new Error("session has no completed turn to fork");
    return this.#store.fork(id, turnId);
  }

  async closeSession(id: string): Promise<void> {
    const slot = this.#slots.get(id);
    if (!slot) return;
    this.#slots.delete(id);
    await slot.cancel().catch(() => undefined);
    await slot.close();
  }

  delete(id: string): Promise<boolean> { return this.#store.delete(id); }
  async close(): Promise<void> {
    const slots = [...this.#slots.values()];
    this.#slots.clear();
    await Promise.allSettled(slots.map((slot) => slot.close()));
  }
}

export function createAcpAgent(options: RunAcpStdioOptions): { app: acp.AgentApp; workspace: AcpWorkspace } {
  const workspace = new AcpWorkspace(options);
  const maxPending = boundedPending(options.maxPendingRequests);
  let pending = 0;
  const limited = <T>(operation: () => Promise<T> | T): Promise<T> => {
    if (pending >= maxPending) return Promise.reject(new Error("too many pending ACP requests"));
    pending++;
    return Promise.resolve().then(operation).finally(() => pending--);
  };
  const modes = (current: Mode) => ({ currentModeId: current, availableModes: [
    { id: "plan", name: "Plan", description: "Plan before making changes" },
    { id: "execute", name: "Execute", description: "Work directly in the repository" },
  ] });

  const app = acp.agent({ name: "vibe-codr" })
    .onConnect((connection) => { workspace.client = connection.client; })
    .onRequest("initialize", ({ params }) => limited(() => ({
      protocolVersion: params.protocolVersion,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, delete: {}, fork: {}, resume: {}, close: {} },
      },
      agentInfo: { name: "vibe-codr", version: "0.6.14" },
      _meta: { "vibe/apiVersion": 1 },
    })))
    .onRequest("session/new", ({ params }) => limited(async () => {
      workspace.assertLocal(params);
      const slot = await workspace.create();
      return { sessionId: slot.sessionId, modes: modes(slot.runtime.snapshot().mode) };
    }))
    .onRequest("session/load", ({ params }) => limited(async () => {
      workspace.assertLocal(params);
      const slot = await workspace.active(params.sessionId);
      return { modes: modes(slot.runtime.snapshot().mode) };
    }))
    .onRequest("session/resume", ({ params }) => limited(async () => {
      workspace.assertLocal(params);
      const slot = await workspace.active(params.sessionId);
      return { modes: modes(slot.runtime.snapshot().mode) };
    }))
    .onRequest("session/list", ({ params }) => limited(async () => {
      if (params.cwd && resolve(params.cwd) !== workspace.cwd) return { sessions: [] };
      if (params.cursor) throw new Error("unknown session cursor");
      return { sessions: await workspace.list() };
    }))
    .onRequest("session/fork", ({ params }) => limited(async () => {
      workspace.assertLocal(params);
      const meta = await workspace.fork(params.sessionId);
      return { sessionId: meta.id, modes: modes(meta.mode) };
    }))
    .onRequest("session/delete", ({ params }) => limited(async () => {
      await workspace.closeSession(params.sessionId);
      if (!(await workspace.delete(params.sessionId))) throw new Error("session not found");
      return {};
    }))
    .onRequest("session/close", ({ params }) => limited(async () => {
      await workspace.closeSession(params.sessionId);
      return {};
    }))
    .onRequest("session/set_mode", ({ params }) => limited(async () => {
      if (params.modeId !== "plan" && params.modeId !== "execute") throw new Error("unsupported mode");
      await (await workspace.active(params.sessionId)).runtime.send({ type: "set-mode", mode: params.modeId });
      return {};
    }))
    .onRequest("session/prompt", ({ params }) => limited(async () => ({
      stopReason: await (await workspace.active(params.sessionId)).prompt(promptText(params.prompt)),
    })))
    .onNotification("session/cancel", ({ params }) => limited(async () => {
      await (await workspace.active(params.sessionId)).cancel();
    }))
    .onRequest(ACP_VIBE_METHODS.capabilities, VibeAcpCapabilitiesRequestSchema, () => limited(() =>
      VibeAcpCapabilitiesResponseSchema.parse({
        apiVersion: 1, transport: "acp-stdio", capabilities: API_V1_CAPABILITIES,
        commandTypes: API_V1_COMMAND_TYPES, replay: "cursor", decisions: "idempotent",
      })))
    .onRequest(ACP_VIBE_METHODS.command, VibeAcpCommandRequestSchema, ({ params }) => limited(async () => {
      await (await workspace.active(params.sessionId)).runtime.send(params.command);
      return VibeAcpCommandResponseSchema.parse({ accepted: true });
    }))
    .onRequest(ACP_VIBE_METHODS.decision, VibeAcpDecisionRequestSchema, ({ params }) => limited(async () =>
      VibeAcpDecisionResponseSchema.parse(await (await workspace.active(params.sessionId)).decide(params.request))))
    .onRequest(ACP_VIBE_METHODS.snapshot, VibeAcpSnapshotRequestSchema, ({ params }) => limited(async () =>
      VibeAcpSnapshotResponseSchema.parse({ snapshot: (await workspace.active(params.sessionId)).runtime.snapshot() })))
    .onRequest(ACP_VIBE_METHODS.replay, VibeAcpReplayRequestSchema, ({ params }) => limited(async () =>
      VibeAcpReplayResponseSchema.parse({ frames: (await workspace.active(params.sessionId)).replay(params.cursor) })));
  return { app, workspace };
}

export async function runAcpStdio(options: RunAcpStdioOptions): Promise<void> {
  const { app, workspace } = createAcpAgent(options);
  const connection = app.connect(boundedNdJsonStream(options.output, options.input, options.maxFrameBytes));
  try {
    await connection.closed;
  } finally {
    await withDeadline(workspace.close(), options.shutdownMs ?? ACP_STDIO_LIMITS.shutdownMs);
  }
}

function boundedPending(value?: number): number {
  const resolved = value ?? ACP_STDIO_LIMITS.pendingRequests;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ACP_STDIO_LIMITS.pendingRequests) {
    throw new Error(`maxPendingRequests must be between 1 and ${ACP_STDIO_LIMITS.pendingRequests}`);
  }
  return resolved;
}

async function withDeadline(operation: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("ACP shutdown deadline exceeded")), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function promptText(blocks: acp.ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "resource_link") return `${block.name ?? "Resource"}: ${block.uri}`;
    throw new Error(`unsupported prompt content: ${block.type}`);
  }).join("\n").trim();
}

export function eventToSessionUpdate(event: UIEvent, pendingDecisionId?: string): SessionUpdate | undefined {
  const meta = { "vibe/event": event, ...(pendingDecisionId ? { "vibe/pendingDecisionId": pendingDecisionId } : {}) };
  if (event.type === "assistant-text-delta") return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.delta }, _meta: meta };
  if (event.type === "reasoning-delta") return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.delta }, _meta: meta };
  if (event.type === "tool-call-started") return { sessionUpdate: "tool_call", toolCallId: event.toolCallId, title: event.toolName, status: "in_progress", rawInput: event.input, _meta: meta };
  if (event.type === "tool-call-progress") return { sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, content: [{ type: "content", content: { type: "text", text: event.chunk } }], _meta: meta };
  if (event.type === "tool-call-finished") return { sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, title: event.toolName, status: event.isError ? "failed" : "completed", rawOutput: event.output, _meta: meta };
  if (event.type === "file-changed") return { sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, kind: "edit", locations: [{ path: event.path }], content: [{ type: "diff", path: event.path, oldText: "", newText: event.diff }], _meta: meta };
  if (event.type === "tasks-updated") return { sessionUpdate: "plan", entries: event.tasks.map((task) => ({ content: task.title, priority: "medium", status: task.status, _meta: { "vibe/taskId": task.id } })), _meta: meta };
  if (pendingDecisionId || event.type === "plan-presented" || event.type === "question-request" || event.type === "permission-request") {
    return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" }, _meta: meta };
  }
  return undefined;
}

function stripBytes(frame: StoredFrame): Extract<ApiV1SseFrame, { type: "event" }> {
  const { bytes: _bytes, ...wire } = frame;
  return wire;
}

function decisionCommand(decision: ApiV1Decision): EngineCommand {
  switch (decision.kind) {
    case "permission": return { type: "resolve-permission", id: decision.id, decision: decision.decision, ...(decision.feedback ? { feedback: decision.feedback } : {}) };
    case "plan": return { type: "resolve-plan", decision: decision.decision, ...(decision.edit ? { edit: decision.edit } : {}), ...(decision.approvals ? { approvals: decision.approvals } : {}) };
    case "question": return { type: "resolve-question", id: decision.id, answers: decision.answers, ...(decision.freeform ? { freeform: decision.freeform } : {}) };
    case "external-capability": return { type: "resolve-external-capability", id: decision.id, decision: decision.decision, ...(decision.result !== undefined ? { result: decision.result } : {}), ...(decision.error ? { error: decision.error } : {}) };
  }
}
