import { createHash } from "node:crypto";
import WebSocket from "ws";
import type { CappedReadResult } from "../shared/capped-read";
import type { EngineCommand } from "../shared/commands";
import { estimateJsonUtf8Bytes } from "../shared/json-size";
import type { PerformancePhaseSample } from "../shared/performance";
import {
  decodeOutbound,
  HOST_PROTOCOL_VERSION,
  type HostEventFrame,
  type HostInbound,
  type HostOutbound,
  type HostReplayResult,
  type HostRpcParams,
  type RpcMethod,
} from "../shared/protocol";
import { isRpcResult } from "../shared/rpc-result-guards";
import { isSchemaEngineSnapshot } from "../shared/schema-runtime-guards";
import type { TerminalCommandResult, TerminalEvent, TerminalOpenRequest, TerminalOpenResult } from "../shared/terminal";
import type { EngineSnapshot } from "../shared/types";
import type { EngineStartOptions } from "./engine-bridge";
import type { EngineTransport } from "./engine-transport";

const READY_TIMEOUT_MS = 45_000;
const RPC_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const CONNECT_RETRY_DELAYS_MS = [250, 750];
const KEEPALIVE_INTERVAL_MS = 15_000;
const CHANNEL_TIMEOUT_MS = 10_000;
const MAX_PENDING_EVENT_FRAMES = 2_048;
const MAX_PENDING_EVENT_BYTES = 8 * 1024 * 1024;
type HostReadyFrame = Extract<HostOutbound, { type: "ready" }>;

interface PendingEventFrame {
  frame: HostEventFrame;
  bytes: number;
}

interface ExistingAgentSession {
  sessionId: string;
  ready: HostReadyFrame | null;
}

interface RemoteTransportOptions {
  url: string;
  accessToken: string;
  headers?: Record<string, string>;
  readyTimeoutMs?: number;
  rpcTimeoutMs?: number;
}

export class RemoteEngineTransport implements EngineTransport {
  #socket: WebSocket | null = null;
  #ready = false;
  #sessionId = "";
  #nextRpcId = 1;
  #rpc = new Map<number, { method: RpcMethod; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #fileRequests = new Map<string, {
    expectsContent: boolean;
    resolve: (data: Buffer) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  #terminalOpenRequests = new Map<string, {
    cwd: string;
    resolve: (result: TerminalOpenResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  #terminalSequences = new Map<string, number>();
  #readyWaiters: Array<{ resolve: (id: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  #agentReady: ((session: ExistingAgentSession | null) => void) | null = null;
  #existingSession: ExistingAgentSession | null | undefined;
  #detachWaiter: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  #keepalive: NodeJS.Timeout | null = null;
  #connecting = false;
  #hostInstanceId = "";
  #lastEventSeq = 0;
  #pendingEventFrames: PendingEventFrame[] = [];
  #pendingEventBytes = 0;
  #replayInFlight = false;

  onEvent: ((event: unknown, frame?: Omit<HostEventFrame, "type" | "event">) => void) | null = null;
  onTerminalEvent: ((event: TerminalEvent) => void) | null = null;
  onFatal: ((message: string) => void) | null = null;
  onReady: ((sessionId: string, info?: { protocolVersion: number; engineRevision: string; capabilities: string[]; hostInstanceId: string }) => void) | null = null;
  onResync: ((snapshot: EngineSnapshot) => void) | null = null;
  onPerformancePhase: ((sample: PerformancePhaseSample) => void) | null = null;

  constructor(private readonly options: RemoteTransportOptions) {}

  get isRunning(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN || this.#socket?.readyState === WebSocket.CONNECTING;
  }

  get isReady(): boolean {
    return this.#ready && this.#socket?.readyState === WebSocket.OPEN;
  }

  async start(options: EngineStartOptions): Promise<string> {
    await this.stop();
    this.#connecting = true;
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt <= CONNECT_RETRY_DELAYS_MS.length; attempt += 1) {
        try { return await this.#startAttempt(options); }
        catch (error) {
          lastError = error;
          if (attempt === CONNECT_RETRY_DELAYS_MS.length || !isTransientDisconnect(error)) throw error;
          await this.#discardSocket();
          await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[attempt]));
        }
      }
      throw lastError;
    } finally {
      this.#connecting = false;
    }
  }

  async #startAttempt(options: EngineStartOptions): Promise<string> {
    const connectionStarted = performance.now();
    this.#existingSession = undefined;
    this.#hostInstanceId = "";
    this.#lastEventSeq = 0;
    this.#clearPendingEventFrames();
    this.#replayInFlight = false;
    const socket = new WebSocket(this.options.url, {
      headers: { ...this.options.headers, authorization: `Bearer ${this.options.accessToken}` },
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: this.options.readyTimeoutMs ?? READY_TIMEOUT_MS,
      perMessageDeflate: false,
    });
    this.#socket = socket;
    socket.on("message", (data) => this.#handleFrame(data.toString()));
    socket.on("error", (error) => this.#fail(`Cloud engine connection failed: ${error.message}`));
    socket.on("close", (code, reason) => {
      const expected = this.#socket !== socket;
      if (this.#socket === socket) this.#socket = null;
      this.#stopKeepalive();
      this.#ready = false;
      this.#resetContinuityState();
      this.#rejectAll(new Error(`Cloud engine disconnected (${code})${reason.length ? `: ${reason.toString()}` : ""}`));
      if (!expected && !this.#connecting) this.onFatal?.(`Cloud engine disconnected (${code})`);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => { this.#startKeepalive(socket); resolve(); });
      socket.once("error", reject);
      socket.once("close", (code) => reject(new Error(`Cloud engine disconnected (${code}) during connection`)));
    });
    this.onPerformancePhase?.({ phase: "host-spawn", durationMs: performance.now() - connectionStarted, transport: "cloud" });
    const readyStarted = performance.now();
    const existing = await new Promise<ExistingAgentSession | null>((resolve) => {
      if (this.#existingSession !== undefined) { resolve(this.#existingSession); return; }
      const timer = setTimeout(() => { this.#agentReady = null; resolve(null); }, 3_000);
      this.#agentReady = (session) => { clearTimeout(timer); this.#agentReady = null; resolve(session); };
    });
    if (existing) {
      if (options.resume && existing.sessionId !== options.resume) {
        await this.disposeForQuit();
        throw new Error(`Cloud sandbox session mismatch: expected ${options.resume}, received ${existing.sessionId}`);
      }
      this.#ready = true;
      this.#sessionId = existing.sessionId;
      if (existing.ready) {
        if (existing.ready.protocolVersion !== HOST_PROTOCOL_VERSION) {
          throw new Error(
            `Cloud engine protocol ${existing.ready.protocolVersion} is incompatible with desktop protocol ${HOST_PROTOCOL_VERSION}`,
          );
        }
      }
      // Ready metadata identifies the host but intentionally carries no event
      // cursor. Always seed from an authoritative snapshot before releasing
      // racing frames, including for a versioned cached cloud-agent ready.
      this.#hostInstanceId = "";
      this.#lastEventSeq = 0;
      const value = await this.rpc("snapshot");
      if (!isSchemaEngineSnapshot(value) || !value.hostInstanceId || !Number.isSafeInteger(value.lastEventSeq)) {
        throw new Error("Cloud engine did not provide a resumable protocol cursor");
      }
      if (existing.ready && existing.ready.hostInstanceId !== value.hostInstanceId) {
        throw new Error("Cloud engine snapshot belongs to a different host instance");
      }
      this.#hostInstanceId = value.hostInstanceId;
      this.#lastEventSeq = value.lastEventSeq ?? 0;
      this.#retainPendingEventFrames(value.hostInstanceId, this.#lastEventSeq);
      this.#flushPendingEventFrames();
      // Older cloud agents cached only the durable session id. The successful
      // v2 snapshot above proves both event replay support and the live host
      // identity, so synthesize the metadata the relay/mobile ready handshake
      // requires instead of leaving the phone waiting forever.
      this.onReady?.(existing.sessionId, existing.ready ? {
        protocolVersion: existing.ready.protocolVersion,
        engineRevision: existing.ready.engineRevision,
        capabilities: [...existing.ready.capabilities],
        hostInstanceId: existing.ready.hostInstanceId,
      } : {
        protocolVersion: HOST_PROTOCOL_VERSION,
        engineRevision: "legacy-cloud-agent",
        capabilities: ["event-replay"],
        hostInstanceId: value.hostInstanceId,
      });
      this.onPerformancePhase?.({ phase: "host-ready", durationMs: performance.now() - readyStarted, transport: "cloud" });
      return existing.sessionId;
    }
    this.#sendHost({
      op: "bootstrap",
      cwd: options.cwd,
      ...(options.resume ? { resume: options.resume } : {}),
      ...(options.continueLatest ? { continue: true } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
    });
    const sessionId = await this.#waitReady();
    this.onPerformancePhase?.({ phase: "host-ready", durationMs: performance.now() - readyStarted, transport: "cloud" });
    if (options.resume && sessionId !== options.resume) {
      await this.stop();
      throw new Error(`Cloud sandbox session mismatch: expected ${options.resume}, received ${sessionId}`);
    }
    return sessionId;
  }

  send(command: EngineCommand): void {
    if (!this.isReady) throw new Error("Cloud engine not ready");
    this.#sendHost({ op: "send", command });
  }

  async rpc(method: RpcMethod, params?: HostRpcParams): Promise<unknown> {
    if (!this.isReady) return Promise.reject(new Error("Cloud engine not ready"));
    const phaseStarted = method === "snapshot" ? performance.now() : 0;
    const id = this.#nextRpcId++;
    try { return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#rpc.delete(id);
        reject(new Error(`Cloud RPC ${method} timed out`));
      }, this.options.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
      this.#rpc.set(id, { method, resolve, reject, timer });
      this.#sendHost({ op: "rpc", id, method, ...(params ? { params } : {}) });
    }); } finally {
      if (method === "snapshot") {
        this.onPerformancePhase?.({ phase: "snapshot", durationMs: performance.now() - phaseStarted, transport: "cloud" });
      }
    }
  }

  readTextFile(path: string, maxBytes: number): Promise<CappedReadResult> {
    if (!this.isReady) return Promise.resolve({ ok: false, error: "Cloud engine not ready" });
    if (!isSafeRemoteRelativePath(path)) return Promise.resolve({ ok: false, error: "Invalid remote file path" });
    const requestId = `file-${this.#nextRpcId++}`;
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fileRequests.delete(requestId);
        reject(new Error("Cloud file read timed out"));
      }, CHANNEL_TIMEOUT_MS);
      this.#fileRequests.set(requestId, { expectsContent: true, resolve, reject, timer });
      this.#sendChannel({ channel: "file", op: "read", requestId, path });
    }).then((data): CappedReadResult => {
      const cap = Math.max(1, Math.trunc(maxBytes));
      const preview = data.subarray(0, Math.min(data.byteLength, cap));
      if (preview.includes(0)) return { ok: false, error: "Binary file — preview unavailable in Cloud" };
      return { ok: true, text: preview.toString("utf8"), truncated: data.byteLength > cap };
    }).catch((error: unknown): CappedReadResult => ({
      ok: false,
      error: error instanceof Error ? error.message : "Couldn’t read Cloud file",
    }));
  }

  writeFile(path: string, data: Buffer, mode = 0o600): Promise<TerminalCommandResult> {
    if (!this.isReady) return Promise.resolve({ ok: false, error: "Cloud engine not ready" });
    if (!isSafeRemoteRelativePath(path) || data.byteLength > 16 * 1024 * 1024) {
      return Promise.resolve({ ok: false, error: "Invalid remote file upload" });
    }
    const requestId = `file-${this.#nextRpcId++}`;
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fileRequests.delete(requestId);
        reject(new Error("Cloud file upload timed out"));
      }, CHANNEL_TIMEOUT_MS);
      this.#fileRequests.set(requestId, { expectsContent: false, resolve, reject, timer });
      this.#sendChannel({
        channel: "file",
        op: "write",
        requestId,
        path,
        contentBase64: data.toString("base64"),
        mode,
      });
    }).then((): TerminalCommandResult => ({ ok: true })).catch((error: unknown): TerminalCommandResult => ({
      ok: false,
      error: error instanceof Error ? error.message : "Couldn’t upload Cloud file",
    }));
  }

  terminalOpen(request: TerminalOpenRequest): Promise<TerminalOpenResult> {
    if (!this.isReady) return Promise.resolve({ ok: false, error: "Cloud engine not ready" });
    const id = `electron-${createHash("sha256").update(`${this.#sessionId}\0${request.cwd}`).digest("hex").slice(0, 24)}`;
    const existing = this.#terminalOpenRequests.get(id);
    if (existing) return Promise.resolve({ ok: false, error: "Cloud terminal is already opening" });
    return new Promise<TerminalOpenResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#terminalOpenRequests.delete(id);
        reject(new Error("Cloud terminal open timed out"));
      }, CHANNEL_TIMEOUT_MS);
      this.#terminalOpenRequests.set(id, { cwd: request.cwd, resolve, reject, timer });
      this.#sendChannel({
        channel: "terminal",
        op: "create",
        requestId: `terminal-open:${id}`,
        id,
        cols: request.cols,
        rows: request.rows,
      });
    });
  }

  terminalWrite(id: string, data: string): TerminalCommandResult {
    if (!this.isReady) return { ok: false, error: "Cloud engine not ready" };
    if (!isRemoteTerminalId(id) || Buffer.byteLength(data) > 64 * 1024) return { ok: false, error: "Invalid Cloud terminal input" };
    this.#sendChannel({ channel: "terminal", op: "write", requestId: `terminal-op:${id}:${this.#nextRpcId++}`, id, data });
    return { ok: true };
  }

  terminalResize(id: string, cols: number, rows: number): TerminalCommandResult {
    if (!this.isReady) return { ok: false, error: "Cloud engine not ready" };
    if (!isRemoteTerminalId(id) || !Number.isFinite(cols) || !Number.isFinite(rows)) return { ok: false, error: "Invalid Cloud terminal size" };
    this.#sendChannel({ channel: "terminal", op: "resize", requestId: `terminal-op:${id}:${this.#nextRpcId++}`, id, cols, rows });
    return { ok: true };
  }

  async stop(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
    this.#resetContinuityState();
    this.#stopKeepalive();
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      this.#sendFrame(socket, { channel: "engine", payload: { op: "shutdown" } });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1_500);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
      socket.close(1000, "client stop");
    });
    this.#rejectAll(new Error("Cloud engine stopped"));
  }

  async disposeForQuit(): Promise<void> {
    // Closing the desktop must not shut down a cloud-owned engine. Disconnect
    // only; cloud-agentd keeps the host, PTYs, replay, and jobs alive for the
    // next authenticated reconnect.
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
    this.#resetContinuityState();
    this.#stopKeepalive();
    if (socket) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { socket.terminate(); resolve(); }, 750);
        socket.once("close", () => { clearTimeout(timer); resolve(); });
        socket.close(1001, "desktop closed");
      });
    }
    this.#rejectAll(new Error("Desktop disconnected from cloud engine"));
  }

  async detachForHandoff(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Cloud engine socket is not open for ownership detach");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#detachWaiter) this.#detachWaiter = null;
        reject(new Error("Cloud agent did not acknowledge engine detach"));
      }, 5_000);
      this.#detachWaiter = { resolve, reject, timer };
      const data = JSON.stringify({ channel: "agent", op: "detach-engine" });
      socket.send(data, (error) => {
        if (!error) return;
        if (this.#detachWaiter) {
          clearTimeout(this.#detachWaiter.timer);
          this.#detachWaiter = null;
        }
        reject(error);
      });
    });
    this.#socket = null;
    this.#ready = false;
    this.#stopKeepalive();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1_000);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
      socket.close(1000, "ownership transferred");
    });
    this.#rejectAll(new Error("Cloud engine ownership transferred"));
  }

  #sendHost(payload: HostInbound): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Cloud engine socket is not open");
    this.#sendFrame(socket, { channel: "engine", payload });
  }

  #sendChannel(frame: unknown): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Cloud agent socket is not open");
    this.#sendFrame(socket, frame);
  }

  #sendFrame(socket: WebSocket, frame: unknown): void {
    const data = JSON.stringify(frame);
    if (Buffer.byteLength(data) > MAX_FRAME_BYTES) throw new Error("Cloud engine frame exceeds 32 MiB");
    socket.send(data);
  }

  #handleFrame(raw: string): void {
    let frame: {
      channel?: unknown;
      payload?: unknown;
      type?: unknown;
      engineSessionId?: unknown;
      engineReady?: unknown;
      message?: unknown;
      error?: unknown;
      requestId?: unknown;
      ok?: unknown;
      contentBase64?: unknown;
      id?: unknown;
      data?: unknown;
      exitCode?: unknown;
      signal?: unknown;
    };
    try { frame = JSON.parse(raw); } catch { this.#fail("Cloud agent emitted malformed JSON"); return; }
    if (frame.channel === "agent" && frame.type === "ready") {
      const sessionId = typeof frame.engineSessionId === "string" ? frame.engineSessionId : null;
      let ready: HostReadyFrame | null = null;
      if (sessionId && frame.engineReady !== undefined) {
        const decoded = decodeOutbound(JSON.stringify(frame.engineReady));
        if (decoded?.type !== "ready" || decoded.sessionId !== sessionId) {
          this.#fail("Cloud agent emitted invalid cached engine ready metadata");
          return;
        }
        ready = decoded;
      }
      const existing = sessionId ? { sessionId, ready } : null;
      this.#existingSession = existing;
      this.#agentReady?.(existing);
      return;
    }
    if (frame.channel === "agent" && frame.type === "detached") {
      const waiter = this.#detachWaiter;
      if (waiter) {
        this.#detachWaiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      return;
    }
    if (frame.channel === "file") {
      this.#handleFileFrame(frame);
      return;
    }
    if (frame.channel === "terminal") {
      this.#handleTerminalFrame(frame);
      return;
    }
    if (frame.channel === "error" && typeof frame.requestId === "string" && this.#handleRequestError(frame.requestId, frame.error)) {
      return;
    }
    if (frame.channel === "fatal" || frame.channel === "error") {
      const detail = typeof frame.message === "string"
        ? frame.message
        : typeof frame.error === "string" ? frame.error : "Cloud agent failed";
      this.#fail(detail);
      return;
    }
    if (frame.channel !== "engine") return;
    const msg = decodeOutbound(JSON.stringify(frame.payload));
    if (!msg) { this.#fail("Cloud agent emitted invalid engine protocol"); return; }
    this.#handleHost(msg);
  }

  #handleFileFrame(frame: { requestId?: unknown; ok?: unknown; contentBase64?: unknown }): void {
    if (typeof frame.requestId !== "string") return;
    const waiter = this.#fileRequests.get(frame.requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.#fileRequests.delete(frame.requestId);
    if (frame.ok !== true || waiter.expectsContent && typeof frame.contentBase64 !== "string") {
      waiter.reject(new Error("Cloud file response was invalid"));
      return;
    }
    waiter.resolve(waiter.expectsContent ? Buffer.from(frame.contentBase64 as string, "base64") : Buffer.alloc(0));
  }

  #handleTerminalFrame(frame: {
    type?: unknown;
    id?: unknown;
    data?: unknown;
    exitCode?: unknown;
    signal?: unknown;
  }): void {
    if (typeof frame.id !== "string" || !isRemoteTerminalId(frame.id)) return;
    const id = frame.id;
    if (frame.type === "created" || frame.type === "replay") {
      const waiter = this.#terminalOpenRequests.get(id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.#terminalOpenRequests.delete(id);
      const replay = frame.type === "replay" && typeof frame.data === "string" ? frame.data : "";
      waiter.resolve({
        ok: true,
        id,
        cwd: waiter.cwd,
        shell: "/bin/bash",
        reused: frame.type === "replay",
        replay,
        sequence: this.#terminalSequences.get(id) ?? 0,
      });
      return;
    }
    if (frame.type === "data" && typeof frame.data === "string" && Buffer.byteLength(frame.data) <= 1024 * 1024) {
      const sequence = (this.#terminalSequences.get(id) ?? 0) + 1;
      this.#terminalSequences.set(id, sequence);
      this.onTerminalEvent?.({ type: "data", id, data: frame.data, sequence });
      return;
    }
    if (frame.type === "exit" && typeof frame.exitCode === "number" && typeof frame.signal === "number") {
      this.#terminalSequences.delete(id);
      this.onTerminalEvent?.({ type: "exit", id, exitCode: frame.exitCode, signal: frame.signal });
    }
  }

  #handleRequestError(requestId: string, value: unknown): boolean {
    const detail = typeof value === "string" ? value : "Cloud channel request failed";
    const file = this.#fileRequests.get(requestId);
    if (file) {
      clearTimeout(file.timer);
      this.#fileRequests.delete(requestId);
      file.reject(new Error(detail));
      return true;
    }
    const terminalPrefix = requestId.startsWith("terminal-open:")
      ? "terminal-open:"
      : requestId.startsWith("terminal-attach:")
        ? "terminal-attach:"
        : null;
    if (terminalPrefix) {
      const id = requestId.slice(terminalPrefix.length);
      const waiter = this.#terminalOpenRequests.get(id);
      if (!waiter) return true;
      if (terminalPrefix === "terminal-open:" && detail === "terminal already exists") {
        this.#sendChannel({ channel: "terminal", op: "attach", requestId: `terminal-attach:${id}`, id });
        return true;
      }
      clearTimeout(waiter.timer);
      this.#terminalOpenRequests.delete(id);
      waiter.resolve({ ok: false, error: detail });
      return true;
    }
    if (requestId.startsWith("terminal-op:")) {
      const id = requestId.slice("terminal-op:".length).split(":", 1)[0];
      if (isRemoteTerminalId(id)) {
        this.#terminalSequences.delete(id);
        this.onTerminalEvent?.({ type: "exit", id, exitCode: 1, signal: 0 });
      }
      return true;
    }
    return false;
  }

  #handleHost(msg: HostOutbound): void {
    if (msg.type === "ready") {
      if (msg.protocolVersion !== HOST_PROTOCOL_VERSION) {
        this.#fail(`Cloud engine protocol ${msg.protocolVersion} is incompatible with desktop protocol ${HOST_PROTOCOL_VERSION}`);
        return;
      }
      this.#ready = true;
      this.#sessionId = msg.sessionId;
      this.#hostInstanceId = msg.hostInstanceId;
      this.#lastEventSeq = 0;
      this.#clearPendingEventFrames();
      this.onReady?.(msg.sessionId, {
        protocolVersion: msg.protocolVersion,
        engineRevision: msg.engineRevision,
        capabilities: [...msg.capabilities],
        hostInstanceId: msg.hostInstanceId,
      });
      for (const waiter of this.#readyWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(msg.sessionId); }
      return;
    }
    if (msg.type === "event") { this.#acceptEventFrame(msg); return; }
    if (msg.type === "fatal") { this.#fail(msg.message); return; }
    const waiter = this.#rpc.get(msg.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.#rpc.delete(msg.id);
    if (msg.ok) {
      if (!isRpcResult(waiter.method, msg.value)) {
        const message = `Cloud engine returned invalid ${waiter.method} response`;
        waiter.reject(new Error(message));
        this.#fail(message);
      } else waiter.resolve(msg.value);
    } else waiter.reject(new Error(msg.error));
  }

  #acceptEventFrame(frame: HostEventFrame): void {
    if (!this.#hostInstanceId && this.#ready) {
      this.#queuePendingEventFrame(frame);
      return;
    }
    if (frame.hostInstanceId !== this.#hostInstanceId) {
      this.#fail("Cloud engine event belongs to a stale host instance");
      return;
    }
    if (frame.seq <= this.#lastEventSeq) return;
    if (!this.#replayInFlight && frame.seq === this.#lastEventSeq + 1) {
      this.#deliverEventFrame(frame);
      return;
    }
    if (!this.#queuePendingEventFrame(frame)) return;
    if (!this.#replayInFlight) void this.#reconcileEventGap();
  }

  #queuePendingEventFrame(frame: HostEventFrame): boolean {
    const bytes = estimateJsonUtf8Bytes(frame, MAX_PENDING_EVENT_BYTES);
    if (bytes > MAX_PENDING_EVENT_BYTES) {
      this.#fail("Cloud engine emitted an event larger than the continuity buffer");
      return false;
    }
    while (
      this.#pendingEventFrames.length >= MAX_PENDING_EVENT_FRAMES
      || this.#pendingEventBytes + bytes > MAX_PENDING_EVENT_BYTES
    ) {
      const removed = this.#pendingEventFrames.shift();
      if (!removed) break;
      this.#pendingEventBytes -= removed.bytes;
    }
    this.#pendingEventFrames.push({ frame, bytes });
    this.#pendingEventBytes += bytes;
    return true;
  }

  #clearPendingEventFrames(): void {
    this.#pendingEventFrames = [];
    this.#pendingEventBytes = 0;
  }

  #resetContinuityState(): void {
    this.#hostInstanceId = "";
    this.#lastEventSeq = 0;
    this.#clearPendingEventFrames();
    this.#replayInFlight = false;
  }

  #retainPendingEventFrames(hostInstanceId: string, afterSeq: number): void {
    this.#pendingEventFrames = this.#pendingEventFrames.filter(
      ({ frame }) => frame.hostInstanceId === hostInstanceId && frame.seq > afterSeq,
    );
    this.#pendingEventBytes = this.#pendingEventFrames.reduce((total, item) => total + item.bytes, 0);
  }

  #flushPendingEventFrames(): void {
    if (!this.#hostInstanceId || !this.#pendingEventFrames.length) return;
    const pending = this.#pendingEventFrames.map(({ frame }) => frame).sort((left, right) => left.seq - right.seq);
    this.#clearPendingEventFrames();
    for (const frame of pending) {
      if (frame.seq <= this.#lastEventSeq) continue;
      if (frame.hostInstanceId !== this.#hostInstanceId || frame.seq !== this.#lastEventSeq + 1) {
        this.#queuePendingEventFrame(frame);
        continue;
      }
      this.#deliverEventFrame(frame);
    }
    if (this.#pendingEventFrames.length && !this.#replayInFlight) {
      void this.#reconcileEventGap();
    }
  }

  #deliverEventFrame(frame: HostEventFrame): void {
    if (frame.seq <= this.#lastEventSeq) return;
    this.#lastEventSeq = frame.seq;
    this.onEvent?.(frame.event, { hostInstanceId: frame.hostInstanceId, seq: frame.seq });
  }

  async #reconcileEventGap(): Promise<void> {
    if (this.#replayInFlight || !this.#hostInstanceId || !this.isReady) return;
    this.#replayInFlight = true;
    const phaseStarted = performance.now();
    try {
      const result = await this.rpc("replayEvents", {
        hostInstanceId: this.#hostInstanceId,
        afterSeq: this.#lastEventSeq,
      }) as HostReplayResult;
      if (result.truncated || result.hostInstanceId !== this.#hostInstanceId) {
        await this.#resyncFromSnapshot();
        return;
      }
      const pending = this.#pendingEventFrames
        .map(({ frame }) => frame)
        .filter((frame) => frame.hostInstanceId === this.#hostInstanceId);
      const frames = [...result.events, ...pending].sort((a, b) => a.seq - b.seq);
      this.#clearPendingEventFrames();
      for (const frame of frames) {
        if (frame.seq <= this.#lastEventSeq) continue;
        if (frame.hostInstanceId !== this.#hostInstanceId || frame.seq !== this.#lastEventSeq + 1) {
          await this.#resyncFromSnapshot();
          return;
        }
        this.#deliverEventFrame(frame);
      }
      if (this.#lastEventSeq < result.lastEventSeq) await this.#resyncFromSnapshot();
    } catch (error) {
      this.#fail(`Cloud engine event replay failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.onPerformancePhase?.({ phase: "replay", durationMs: performance.now() - phaseStarted, transport: "cloud" });
      this.#replayInFlight = false;
      if (this.isReady && this.#pendingEventFrames.some(({ frame }) => frame.seq > this.#lastEventSeq)) {
        void this.#reconcileEventGap();
      }
    }
  }

  async #resyncFromSnapshot(): Promise<void> {
    const value = await this.rpc("snapshot");
    if (!isRpcResult("snapshot", value)) throw new Error("cloud host returned an invalid resync snapshot");
    const snapshot = value as EngineSnapshot;
    if (snapshot.hostInstanceId !== this.#hostInstanceId || !Number.isSafeInteger(snapshot.lastEventSeq)) {
      throw new Error("cloud host returned a mismatched resync cursor");
    }
    this.#lastEventSeq = snapshot.lastEventSeq ?? this.#lastEventSeq;
    this.#retainPendingEventFrames(this.#hostInstanceId, this.#lastEventSeq);
    this.onResync?.(snapshot);
  }

  #waitReady(): Promise<string> {
    if (this.#ready) return Promise.resolve(this.#sessionId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A socket that connected but never completed the authenticated ready
        // handshake must not survive as an unreachable cloud connection.
        this.#fail("Cloud engine timed out waiting for ready");
      }, this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
      this.#readyWaiters.push({ resolve, reject, timer });
    });
  }

  #fail(message: string): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
    this.#resetContinuityState();
    this.#stopKeepalive();
    if (!this.#connecting) this.onFatal?.(message);
    this.#rejectAll(new Error(message));
    socket?.terminate();
  }

  async #discardSocket(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
    this.#resetContinuityState();
    this.#stopKeepalive();
    if (!socket) return;
    socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  #startKeepalive(socket: WebSocket): void {
    this.#stopKeepalive();
    this.#keepalive = setInterval(() => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      this.#sendFrame(socket, { channel: "ping", at: Date.now() });
    }, KEEPALIVE_INTERVAL_MS);
    this.#keepalive.unref();
  }

  #stopKeepalive(): void {
    if (this.#keepalive) clearInterval(this.#keepalive);
    this.#keepalive = null;
  }

  #rejectAll(error: Error): void {
    for (const waiter of this.#rpc.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.#rpc.clear();
    for (const waiter of this.#fileRequests.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.#fileRequests.clear();
    for (const waiter of this.#terminalOpenRequests.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.#terminalOpenRequests.clear();
    this.#terminalSequences.clear();
    for (const waiter of this.#readyWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
    if (this.#detachWaiter) {
      clearTimeout(this.#detachWaiter.timer);
      this.#detachWaiter.reject(error);
      this.#detachWaiter = null;
    }
  }
}

function isSafeRemoteRelativePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized.length > 0
    && !normalized.startsWith("/")
    && !normalized.includes("\0")
    && normalized.split("/").every((component) => component !== ".." && component !== "");
}

function isRemoteTerminalId(id: string): boolean {
  return /^electron-[a-f0-9]{24}$/.test(id);
}

function isTransientDisconnect(error: unknown): boolean {
  const value = error instanceof Error ? error.message : String(error);
  return /\b1006\b|ECONNRESET|EPIPE|socket hang up|unexpected server response|network/i.test(value);
}
