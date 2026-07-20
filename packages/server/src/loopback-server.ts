import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { type PersistedSession, type SessionMeta, SessionStore } from "@vibe/core";
import {
  API_V1_CAPABILITIES,
  API_V1_COMMAND_TYPES,
  API_V1_LIMITS,
  ApiV1AcceptedResponseSchema,
  ApiV1CapabilitiesResponseSchema,
  type ApiV1Command,
  ApiV1CommandRequestSchema,
  ApiV1CreateSessionRequestSchema,
  type ApiV1Cursor,
  type ApiV1Decision,
  type ApiV1DecisionReceipt,
  ApiV1DecisionReceiptSchema,
  ApiV1DecisionRequestSchema,
  ApiV1EmptyRequestSchema,
  ApiV1ErrorSchema,
  ApiV1ForkRequestSchema,
  ApiV1ForkResponseSchema,
  ApiV1GetSessionResponseSchema,
  ApiV1ListSessionsResponseSchema,
  ApiV1MutationResponseSchema,
  ApiV1PromptRequestSchema,
  type ApiV1Session,
  ApiV1SessionResponseSchema,
  ApiV1SseEventSchema,
  type ApiV1SseFrame,
  ApiV1SseReadySchema,
  decodeApiV1Cursor,
  encodeApiV1Cursor,
} from "@vibe/protocol";
import { openRuntimeSession } from "@vibe/runtime";
import type { EngineCommand, EngineSnapshot, Mode, UIEvent } from "@vibe/shared";
import { loadOrCreateLoopbackToken, matchesLoopbackBearer } from "./token.ts";

export interface LoopbackRuntime {
  events(): AsyncIterable<UIEvent>;
  send(command: EngineCommand): Promise<void> | void;
  snapshot(): EngineSnapshot;
  close(): Promise<void>;
}

export interface LoopbackSessionStore {
  list(): Promise<SessionMeta[]>;
  load(id: string): Promise<PersistedSession | null>;
  fork(id: string, atTurnId: string): Promise<SessionMeta>;
  archive(id: string): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

export interface StartLoopbackServerOptions {
  cwd: string;
  port?: number;
  hostname?: string;
  tokenDirectory?: string;
  replayFrames?: number;
  replayBytes?: number;
  dependencies?: {
    store?: LoopbackSessionStore;
    openRuntime?: (input: {
      cwd: string;
      resume: { kind: "new" } | { kind: "loaded"; session: PersistedSession };
      model?: string;
      mode?: Mode;
    }) => Promise<LoopbackRuntime>;
    token?: { token: string; path: string };
  };
}

export interface LoopbackServerHandle {
  hostname: "127.0.0.1";
  port: number;
  url: string;
  token: string;
  tokenPath: string;
  stop(): Promise<void>;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
  }
}

type PendingKind = ApiV1Decision["kind"];
type StoredReceipt = { digest: string; receipt: ApiV1DecisionReceipt };
type StoredFrame = Extract<ApiV1SseFrame, { type: "event" }> & { bytes: number };

const DENIED_SLASH_COMMANDS = new Set([
  "handoff",
  "terminal",
  "pty",
  "cd",
  "workspace",
  "cloud",
  "continue-on-phone",
]);

class RuntimeSlot {
  readonly pending = new Map<string, PendingKind>();
  readonly receipts = new Map<string, StoredReceipt>();
  readonly #frames: StoredFrame[] = [];
  readonly #subscribers = new Set<(frame: Extract<ApiV1SseFrame, { type: "event" }>) => void>();
  #replayBytes = 0;
  #closed = false;

  constructor(
    readonly runtime: LoopbackRuntime,
    readonly epoch: string,
    readonly meta: SessionMeta,
    readonly nextSequence: () => number,
    readonly replayFrameLimit: number,
    readonly replayByteLimit: number,
  ) {
    void this.#consume();
  }

  get sessionId(): string {
    return this.runtime.snapshot().sessionId;
  }

  get lastSequence(): number {
    return this.#frames.at(-1)?.cursor.sequence ?? 0;
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
        const stored: StoredFrame = { ...parsed, bytes };
        this.#frames.push(stored);
        this.#replayBytes += bytes;
        while (
          this.#frames.length > this.replayFrameLimit ||
          this.#replayBytes > this.replayByteLimit
        ) {
          const removed = this.#frames.shift();
          if (removed) this.#replayBytes -= removed.bytes;
        }
        for (const subscriber of this.#subscribers) subscriber(parsed);
      }
    } catch {
      // Runtime lifecycle remains authoritative. A subscriber reconnect gets a
      // validated snapshot instead of transport-owned synthetic engine state.
    }
  }

  #observePending(event: UIEvent, sequence: number): string | undefined {
    if (event.type === "permission-request") {
      this.pending.set(event.id, "permission");
      return event.id;
    }
    if (event.type === "permission-settled") {
      for (const id of event.ids) this.pending.delete(id);
    } else if (event.type === "question-request") {
      this.pending.set(event.question.id, "question");
      return event.question.id;
    } else if (event.type === "question-settled") {
      this.pending.delete(event.id);
    } else if (event.type === "external-capability-pending") {
      this.pending.set(event.request.id, "external-capability");
      return event.request.id;
    } else if (event.type === "external-capability-resolved") {
      this.pending.delete(event.id);
    } else if (event.type === "plan-presented") {
      for (const [id, kind] of this.pending) if (kind === "plan") this.pending.delete(id);
      const id = `plan-${sequence}`;
      this.pending.set(id, "plan");
      return id;
    } else if (event.type === "plan-state-changed" && event.state.status !== "pending") {
      for (const [id, kind] of this.pending) if (kind === "plan") this.pending.delete(id);
    }
    return undefined;
  }

  replay(cursor: ApiV1Cursor | undefined): {
    ready: ReturnType<typeof ApiV1SseReadySchema.parse>;
    frames: Extract<ApiV1SseFrame, { type: "event" }>[];
  } {
    const snapshot = this.runtime.snapshot();
    const currentSequence = this.#frames.at(-1)?.cursor.sequence ?? 0;
    const firstSequence = this.#frames[0]?.cursor.sequence;
    const truncated = Boolean(
      cursor &&
        (cursor.epoch !== this.epoch ||
          cursor.sequence > currentSequence ||
          (cursor.sequence < currentSequence &&
            (firstSequence === undefined || cursor.sequence < firstSequence - 1))),
    );
    const frames =
      cursor && !truncated
        ? this.#frames
            .filter((frame) => frame.cursor.sequence > cursor.sequence)
            .map(stripStoredBytes)
        : [];
    return {
      ready: ApiV1SseReadySchema.parse({
        type: "ready",
        cursor: { epoch: this.epoch, sequence: currentSequence },
        truncated,
        ...(truncated ? { snapshot } : {}),
      }),
      frames,
    };
  }

  subscribe(listener: (frame: Extract<ApiV1SseFrame, { type: "event" }>) => void): () => void {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscribers.clear();
    await this.runtime.close();
  }
}

function stripStoredBytes(frame: StoredFrame): Extract<ApiV1SseFrame, { type: "event" }> {
  const { bytes: _bytes, ...wire } = frame;
  return wire;
}

class LoopbackWorkspace {
  readonly cwd: string;
  readonly epoch = randomBytes(16).toString("hex");
  readonly #store: LoopbackSessionStore;
  readonly #openRuntime: NonNullable<
    NonNullable<StartLoopbackServerOptions["dependencies"]>["openRuntime"]
  >;
  readonly #slots = new Map<string, RuntimeSlot>();
  readonly #replayFrames: number;
  readonly #replayBytes: number;
  #sequence = 0;

  constructor(options: StartLoopbackServerOptions) {
    this.cwd = resolve(options.cwd);
    this.#store = options.dependencies?.store ?? new SessionStore(this.cwd);
    this.#openRuntime =
      options.dependencies?.openRuntime ??
      (async ({ cwd, resume, model, mode }) =>
        openRuntimeSession({
          cwd,
          interactive: true,
          resume,
          ...(model ? { modelOverride: model } : {}),
          ...(mode ? { modeOverride: mode } : {}),
        }));
    this.#replayFrames = boundedLimit(options.replayFrames, API_V1_LIMITS.replayFrames);
    this.#replayBytes = boundedLimit(options.replayBytes, API_V1_LIMITS.replayBytes);
  }

  async list(): Promise<ApiV1Session[]> {
    const durable = await this.#store.list();
    const sessions = new Map(
      durable.map((meta) => [meta.id, sessionFromMeta(meta, this.#slots.has(meta.id))]),
    );
    for (const slot of this.#slots.values()) sessions.set(slot.sessionId, sessionFromSlot(slot));
    return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(input: { model?: string; mode?: Mode }): Promise<RuntimeSlot> {
    const runtime = await this.#openRuntime({ cwd: this.cwd, resume: { kind: "new" }, ...input });
    const snapshot = runtime.snapshot();
    const now = Date.now();
    const slot = this.#attach(runtime, {
      id: snapshot.sessionId,
      model: snapshot.model,
      mode: snapshot.mode,
      goal: snapshot.goal,
      createdAt: now,
      updatedAt: now,
    });
    return slot;
  }

  async get(id: string): Promise<{ session: ApiV1Session; snapshot?: EngineSnapshot }> {
    const active = this.#slots.get(id);
    if (active) return { session: sessionFromSlot(active), snapshot: active.runtime.snapshot() };
    const loaded = await this.#store.load(id);
    if (!loaded) throw new HttpFailure(404, "session-not-found", "session not found");
    return { session: sessionFromMeta(loaded.meta, false) };
  }

  async active(id: string): Promise<RuntimeSlot> {
    const active = this.#slots.get(id);
    if (active) return active;
    const loaded = await this.#store.load(id);
    if (!loaded) throw new HttpFailure(404, "session-not-found", "session not found");
    const runtime = await this.#openRuntime({
      cwd: this.cwd,
      resume: { kind: "loaded", session: loaded },
    });
    return this.#attach(runtime, loaded.meta);
  }

  #attach(runtime: LoopbackRuntime, meta: SessionMeta): RuntimeSlot {
    const id = runtime.snapshot().sessionId;
    if (id !== meta.id) throw new Error("runtime session identity does not match durable session");
    const slot = new RuntimeSlot(
      runtime,
      this.epoch,
      meta,
      () => ++this.#sequence,
      this.#replayFrames,
      this.#replayBytes,
    );
    this.#slots.set(id, slot);
    return slot;
  }

  async fork(id: string, atTurnId: string): Promise<ApiV1Session> {
    const meta = await this.#store.fork(id, atTurnId);
    return sessionFromMeta(meta, false);
  }

  async archive(id: string): Promise<boolean> {
    await this.#detach(id);
    return this.#store.archive(id);
  }

  async delete(id: string): Promise<boolean> {
    await this.#detach(id);
    return this.#store.delete(id);
  }

  async #detach(id: string): Promise<void> {
    const slot = this.#slots.get(id);
    if (!slot) return;
    this.#slots.delete(id);
    await slot.close();
  }

  async close(): Promise<void> {
    const slots = [...this.#slots.values()];
    this.#slots.clear();
    await Promise.allSettled(slots.map((slot) => slot.close()));
  }
}

function boundedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`limit must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function sessionFromMeta(meta: SessionMeta, active: boolean): ApiV1Session {
  return {
    id: meta.id,
    model: meta.model,
    mode: meta.mode,
    goal: meta.goal,
    ...(meta.title ? { title: meta.title } : {}),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    active,
    ...(meta.forkedFrom ? { forkedFrom: meta.forkedFrom } : {}),
    ...(meta.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
    ...(meta.forkedAtTurnId ? { forkedAtTurnId: meta.forkedAtTurnId } : {}),
  };
}

function sessionFromSlot(slot: RuntimeSlot): ApiV1Session {
  const snapshot = slot.runtime.snapshot();
  return {
    ...sessionFromMeta(slot.meta, true),
    model: snapshot.model,
    mode: snapshot.mode,
    goal: snapshot.goal,
  };
}

function decisionCommand(decision: ApiV1Decision): EngineCommand {
  switch (decision.kind) {
    case "permission":
      return {
        type: "resolve-permission",
        id: decision.id,
        decision: decision.decision,
        ...(decision.feedback ? { feedback: decision.feedback } : {}),
      };
    case "plan":
      return {
        type: "resolve-plan",
        decision: decision.decision,
        ...(decision.edit ? { edit: decision.edit } : {}),
        ...(decision.approvals ? { approvals: decision.approvals } : {}),
      };
    case "question":
      return {
        type: "resolve-question",
        id: decision.id,
        answers: decision.answers,
        ...(decision.freeform ? { freeform: decision.freeform } : {}),
      };
    case "external-capability":
      return {
        type: "resolve-external-capability",
        id: decision.id,
        decision: decision.decision,
        ...(decision.result !== undefined ? { result: decision.result } : {}),
        ...(decision.error ? { error: decision.error } : {}),
      };
  }
}

function assertSupportedCommand(slot: RuntimeSlot, command: ApiV1Command): void {
  if (command.type !== "run-slash") return;
  if (
    DENIED_SLASH_COMMANDS.has(command.name) ||
    !slot.runtime.snapshot().commandNames.includes(command.name)
  ) {
    throw new HttpFailure(
      409,
      "unsupported-command",
      `slash command is not supported by API v1: ${command.name}`,
    );
  }
}

function requestHeaderBytes(request: Request): number {
  let bytes = 0;
  request.headers.forEach((value, key) => {
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 4;
  });
  return bytes;
}

async function validatedBody<T>(
  request: Request,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > API_V1_LIMITS.bodyBytes)
    throw new HttpFailure(413, "body-too-large", "request body exceeds the API v1 limit");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > API_V1_LIMITS.bodyBytes)
    throw new HttpFailure(413, "body-too-large", "request body exceeds the API v1 limit");
  let value: unknown;
  try {
    value = bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {};
  } catch {
    throw new HttpFailure(400, "invalid-json", "request body is not valid JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new HttpFailure(400, "invalid-request", "request body does not match the API v1 schema");
  return parsed.data;
}

function json(schema: { parse(value: unknown): unknown }, value: unknown, status = 200): Response {
  return Response.json(schema.parse(value), { status, headers: { "cache-control": "no-store" } });
}

function failureResponse(error: unknown): Response {
  const failure =
    error instanceof HttpFailure
      ? error
      : new HttpFailure(500, "internal-error", "loopback server request failed");
  return json(
    ApiV1ErrorSchema,
    {
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.status >= 500,
        ...(failure.details ? { details: failure.details } : {}),
      },
    },
    failure.status,
  );
}

function sseData(frame: ApiV1SseFrame): Uint8Array {
  return new TextEncoder().encode(
    `id: ${encodeApiV1Cursor(frame.cursor)}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
  );
}

/** Start the v1 server. The bind address is intentionally not configurable. */
export async function startLoopbackServer(
  options: StartLoopbackServerOptions,
): Promise<LoopbackServerHandle> {
  if (options.hostname !== undefined && options.hostname !== "127.0.0.1") {
    throw new Error("vibe serve only permits the loopback bind 127.0.0.1");
  }
  if (
    options.port !== undefined &&
    (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
  ) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  const token =
    options.dependencies?.token ?? (await loadOrCreateLoopbackToken(options.tokenDirectory));
  const workspace = new LoopbackWorkspace(options);
  let requests = 0;
  let sseConnections = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: API_V1_LIMITS.idleSeconds,
    maxRequestBodySize: API_V1_LIMITS.bodyBytes,
    async fetch(request) {
      if (++requests > API_V1_LIMITS.connections) {
        requests--;
        return failureResponse(
          new HttpFailure(503, "connection-limit", "too many concurrent API requests"),
        );
      }
      try {
        if (requestHeaderBytes(request) > API_V1_LIMITS.headerBytes)
          throw new HttpFailure(
            431,
            "headers-too-large",
            "request headers exceed the API v1 limit",
          );
        if (!matchesLoopbackBearer(token.token, request.headers.get("authorization")))
          throw new HttpFailure(401, "unauthorized", "a valid bearer token is required");
        const url = new URL(request.url);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/v1/capabilities") {
          return json(ApiV1CapabilitiesResponseSchema, {
            apiVersion: 1,
            workspace: workspace.cwd,
            transport: "loopback",
            events: "authenticated-sse",
            capabilities: API_V1_CAPABILITIES,
            commandTypes: API_V1_COMMAND_TYPES,
          });
        }
        if (request.method === "GET" && pathname === "/v1/sessions") {
          return json(ApiV1ListSessionsResponseSchema, { sessions: await workspace.list() });
        }
        if (request.method === "POST" && pathname === "/v1/sessions") {
          const input = await validatedBody(request, ApiV1CreateSessionRequestSchema);
          const slot = await workspace.create(input);
          return json(
            ApiV1SessionResponseSchema,
            { session: sessionFromSlot(slot), snapshot: slot.runtime.snapshot() },
            201,
          );
        }

        const match = pathname.match(
          /^\/v1\/sessions\/([^/]+)(?:\/(prompt|command|fork|decision|events|archive))?$/,
        );
        if (!match) throw new HttpFailure(404, "not-found", "API route not found");
        const id = decodeURIComponent(match[1] ?? "");
        const action = match[2];

        if (request.method === "GET" && action === undefined) {
          return json(ApiV1GetSessionResponseSchema, await workspace.get(id));
        }
        if (request.method === "POST" && action === "prompt") {
          const input = await validatedBody(request, ApiV1PromptRequestSchema);
          const slot = await workspace.active(id);
          await slot.runtime.send({ type: "submit-prompt", text: input.text });
          return json(ApiV1AcceptedResponseSchema, { accepted: true }, 202);
        }
        if (request.method === "POST" && action === "command") {
          const input = await validatedBody(request, ApiV1CommandRequestSchema);
          const slot = await workspace.active(id);
          assertSupportedCommand(slot, input.command);
          await slot.runtime.send(input.command);
          return json(ApiV1AcceptedResponseSchema, { accepted: true }, 202);
        }
        if (request.method === "POST" && action === "fork") {
          const input = await validatedBody(request, ApiV1ForkRequestSchema);
          return json(
            ApiV1ForkResponseSchema,
            { session: await workspace.fork(id, input.atTurnId) },
            201,
          );
        }
        if (request.method === "POST" && action === "decision") {
          const input = await validatedBody(request, ApiV1DecisionRequestSchema);
          const slot = await workspace.active(id);
          const digest = createHash("sha256").update(JSON.stringify(input.decision)).digest("hex");
          const stored = slot.receipts.get(input.idempotencyKey);
          if (stored) {
            if (stored.digest !== digest)
              throw new HttpFailure(
                409,
                "idempotency-conflict",
                "idempotency key was already used with a different decision",
              );
            return json(ApiV1DecisionReceiptSchema, stored.receipt);
          }
          if (slot.pending.get(input.decision.id) !== input.decision.kind) {
            throw new HttpFailure(
              409,
              "stale-decision",
              "pending decision does not exist or no longer accepts this decision kind",
            );
          }
          const receipt = ApiV1DecisionReceiptSchema.parse({
            receiptId: `rcpt-${randomUUID()}`,
            idempotencyKey: input.idempotencyKey,
            sessionId: id,
            pendingId: input.decision.id,
            acceptedAt: Date.now(),
          });
          slot.pending.delete(input.decision.id);
          slot.receipts.set(input.idempotencyKey, { digest, receipt });
          try {
            await slot.runtime.send(decisionCommand(input.decision));
          } catch (error) {
            slot.receipts.delete(input.idempotencyKey);
            slot.pending.set(input.decision.id, input.decision.kind);
            throw error;
          }
          return json(ApiV1DecisionReceiptSchema, receipt, 202);
        }
        if (request.method === "GET" && action === "events") {
          if (sseConnections >= API_V1_LIMITS.sseConnections)
            throw new HttpFailure(503, "sse-limit", "too many event streams");
          const rawCursor = url.searchParams.get("cursor") ?? request.headers.get("last-event-id");
          const cursor = decodeApiV1Cursor(rawCursor);
          if (rawCursor && !cursor)
            throw new HttpFailure(400, "invalid-cursor", "event cursor is malformed");
          const slot = await workspace.active(id);
          const replay = slot.replay(cursor);
          sseConnections++;
          let release: (() => void) | undefined;
          let heartbeat: ReturnType<typeof setInterval> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(sseData(replay.ready));
              for (const frame of replay.frames) controller.enqueue(sseData(frame));
              release = slot.subscribe((frame) => {
                try {
                  controller.enqueue(sseData(frame));
                } catch {
                  release?.();
                }
              });
              heartbeat = setInterval(() => {
                try {
                  controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
                } catch {
                  release?.();
                }
              }, 15_000);
            },
            cancel() {
              release?.();
              if (heartbeat) clearInterval(heartbeat);
              sseConnections--;
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-store",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            },
          });
        }
        if (request.method === "POST" && action === "archive") {
          await validatedBody(request, ApiV1EmptyRequestSchema);
          if (!(await workspace.archive(id)))
            throw new HttpFailure(404, "session-not-found", "session not found");
          return json(ApiV1MutationResponseSchema, { id, ok: true });
        }
        if (request.method === "DELETE" && action === undefined) {
          if (!(await workspace.delete(id)))
            throw new HttpFailure(404, "session-not-found", "session not found");
          return json(ApiV1MutationResponseSchema, { id, ok: true });
        }
        throw new HttpFailure(
          405,
          "method-not-allowed",
          "method is not allowed for this API route",
        );
      } catch (error) {
        return failureResponse(error);
      } finally {
        requests--;
      }
    },
  });

  const boundPort = server.port;
  if (boundPort === undefined) {
    server.stop(true);
    await workspace.close();
    throw new Error("loopback server did not report its bound port");
  }
  return {
    hostname: "127.0.0.1",
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    token: token.token,
    tokenPath: token.path,
    async stop() {
      server.stop(true);
      await workspace.close();
    },
  };
}
