// Remote engine client for the mobile renderer. Speaks the exact same NDJSON
// host protocol as the Electron `RemoteEngineTransport` / `EngineBridge`
// (bootstrap / send / rpc / shutdown), over React Native's built-in WebSocket.
// Reuses the shared `encodeInbound` / `decodeOutbound` / guards so the wire
// contract is byte-identical to the desktop shell — 1:1 by construction.
import type { EngineCommand } from "@shared/commands";
import { estimateJsonUtf8Bytes } from "@shared/json-size";
import { encodeInbound, decodeOutbound, HOST_PROTOCOL_VERSION, incompatibleHostProtocolVersion, type HostEventFrame, type HostOutbound, type HostReplayResult, type RpcMethod, type HostRpcParams } from "@shared/protocol";
import { isUIEvent } from "@shared/protocol";
import { isRpcResult } from "@shared/rpc-result-guards";
import { isEngineSnapshot } from "@shared/runtime-guards";
import { isRelayOutbound, type CloudRelayRequest, type CloudRelayResult, type GitRelayRequest, type GitRelayResult, type MobileUploadResult, type RelayOutbound } from "../../../relay/protocol";
import type { ConfigReadResult, ConfigWriteRequest, MemoryFileResult, MemoryWriteRequest, ConfigScope } from "@shared/config-schema";
import type { UIEvent } from "@shared/events";
import type { EngineSnapshot, ModelSummary, ProviderInfo, AgentInfo, SkillInfo } from "@shared/types";

export interface RemoteClientOptions {
  url: string;          // ws(s)://host:port  (relay or cloud engine)
  accessToken: string;  // bearer — sent as ?token= (RN WebSocket has no header API)
  cwd: string;
  resume?: string;
  continueLatest?: boolean;
  model?: string;
  mode?: "plan" | "execute" | "yolo";
  readyTimeoutMs?: number;
  rpcTimeoutMs?: number;
  /** Reconnect with exponential backoff on unexpected disconnect (default true). */
  autoReconnect?: boolean;
  /** Deterministic reconnect schedule override for tests. */
  reconnectDelaysMs?: readonly number[];
}

const READY_TIMEOUT_MS = 45_000;
const RPC_TIMEOUT_MS = 30_000;
const KEEPALIVE_MS = 15_000;
const KEEPALIVE_PAYLOAD = '{"op":"ping"}\n';
const RECONNECT_DELAYS_MS = [500, 1500, 5000, 15_000, 30_000];
const TERMINAL_CLOSE_CODES = new Set([4001, 4003, 4004]);
const MAX_PENDING_EVENT_FRAMES = 2_048;
const MAX_PENDING_EVENT_BYTES = 8 * 1024 * 1024;

interface PendingEventFrame {
  frame: HostEventFrame;
  bytes: number;
}

type EventSink = (event: UIEvent) => void;
export type RemoteConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

export class RemoteEngineClient {
  #socket: WebSocket | null = null;
  #sessionId = "";
  #ready = false;
  #nextRpcId = 1;
  #nextRelayId = 1;
  #rpc = new Map<number, { method: RpcMethod; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #readyWaiter: { resolve: (id: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  #keepalive: ReturnType<typeof setInterval> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempts = 0;
  #socketGeneration = 0;
  #lastBootstrap: { cwd: string; resume?: string; continueLatest?: boolean; model?: string; mode?: string } | null = null;
  #sinks = new Set<EventSink>();
  #fatal: ((msg: string) => void) | null = null;
  #snapshot: EngineSnapshot | null = null;
  #opts: RemoteClientOptions;
  #reconnectDelays: readonly number[];
  #closed = false;
  #terminallyDisconnected = false;
  #foregroundReconnect: Promise<string> | null = null;
  #hostInstanceId = "";
  #lastEventSeq = 0;
  #pendingEventFrames: PendingEventFrame[] = [];
  #pendingEventBytes = 0;
  #replayInFlight = false;

  onFatal: ((message: string) => void) | null = null;
  onReady: ((sessionId: string) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  onConnectionState: ((state: RemoteConnectionState) => void) | null = null;
  #relaySinks = new Set<(frame: RelayOutbound) => void>();
  #relayRequests = new Map<string, {
    resolve: (frame: RelayOutbound) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(opts: RemoteClientOptions) {
    this.#opts = opts;
    this.#reconnectDelays = opts.reconnectDelaysMs?.length ? opts.reconnectDelaysMs : RECONNECT_DELAYS_MS;
    this.#fatal = (msg) => this.onFatal?.(msg);
  }

  get isReady(): boolean { return this.#ready; }
  get sessionId(): string { return this.#sessionId; }

  async connect(): Promise<string> {
    this.#closed = false;
    this.#terminallyDisconnected = false;
    const socket = await this.#openSocket("connecting");
    this.#lastBootstrap = { cwd: this.#opts.cwd, resume: this.#opts.resume, continueLatest: this.#opts.continueLatest, model: this.#opts.model, mode: this.#opts.mode };
    this.#sendBootstrap(this.#lastBootstrap);
    try {
      return await this.#waitForReady();
    } catch (error) {
      this.#discardSocket(socket);
      throw error;
    }
  }

  /** Re-bootstrap over the open socket to switch project/session (remote control
   *  of a different cwd / resume id without dropping the relay connection). */
  async rebootstrap(opts: { cwd: string; resume?: string; continueLatest?: boolean; model?: string; mode?: "plan" | "execute" | "yolo" }): Promise<string> {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error("Not connected");
    this.#ready = false;
    this.#snapshot = null;
    this.#lastBootstrap = opts;
    this.#sendBootstrap(opts);
    return this.#waitForReady();
  }

  /** iOS may suspend JavaScript before a dead WebSocket delivers `close`.
   * Foreground recovery replaces that socket without sending engine shutdown,
   * then resumes the exact session so `onReady` can hydrate a fresh snapshot. */
  refreshAfterForeground(): Promise<string> {
    if (this.#closed) return Promise.reject(new Error("Engine connection is closed"));
    if (this.#terminallyDisconnected) return Promise.reject(new Error("Engine ownership or authentication ended"));
    if (!this.#lastBootstrap) return Promise.reject(new Error("Engine has not bootstrapped"));
    if (this.#foregroundReconnect) return this.#foregroundReconnect;
    this.#foregroundReconnect = this.#refreshAfterForeground().finally(() => {
      this.#foregroundReconnect = null;
    });
    return this.#foregroundReconnect;
  }

  async #refreshAfterForeground(): Promise<string> {
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
    const error = new Error("Connection refreshed after returning to foreground");
    this.#readyWaiter?.reject(error);
    this.#readyWaiter = null;
    for (const waiter of this.#rpc.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.#rpc.clear();
    this.#rejectRelayRequests(error);
    const socket = this.#socket;
    if (socket) this.#discardSocket(socket);
    this.onConnectionState?.("reconnecting");
    try {
      return await this.#reconnectWithLast();
    } catch (reconnectError) {
      if (!this.#closed && this.#opts.autoReconnect !== false) this.#scheduleReconnect();
      throw reconnectError;
    }
  }

  #sendBootstrap(opts: { cwd: string; resume?: string; continueLatest?: boolean; model?: string; mode?: string }): void {
    this.#send(encodeInbound({
      op: "bootstrap",
      cwd: opts.cwd,
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(opts.continueLatest ? { continue: true } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.mode ? { mode: opts.mode as "plan" | "execute" | "yolo" } : {}),
    }));
  }

  #waitForReady(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.#readyWaiter = null; reject(new Error("Engine ready timeout")); }, this.#opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
      this.#readyWaiter = { resolve: (id) => { clearTimeout(timer); resolve(id); }, reject: (e) => { clearTimeout(timer); reject(e); }, timer };
    });
  }

  #handleMessage(data: string): void {
    // The relay may batch multiple NDJSON lines in one frame.
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown = null;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (isRelayOutbound(parsed)) {
        const frame = parsed as RelayOutbound;
        if ("requestId" in frame) {
          const waiter = this.#relayRequests.get(frame.requestId);
          if (waiter) {
            this.#relayRequests.delete(frame.requestId);
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          }
        }
        for (const sink of this.#relaySinks) sink(frame);
        continue;
      }
      const msg = decodeOutbound(line);
      if (!msg) {
        const incompatibleVersion = incompatibleHostProtocolVersion(line);
        if (incompatibleVersion !== null) {
          this.#recoverFromContinuityFailure(
            `Engine protocol ${incompatibleVersion} is incompatible with mobile protocol ${HOST_PROTOCOL_VERSION}`,
            false,
          );
        }
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg: HostOutbound): void {
    if (msg.type === "ready") {
      if (msg.protocolVersion !== HOST_PROTOCOL_VERSION) {
        this.#recoverFromContinuityFailure(
          `Engine protocol ${msg.protocolVersion} is incompatible with mobile protocol ${HOST_PROTOCOL_VERSION}`,
          false,
        );
        return;
      }
      this.#ready = true;
      this.#snapshot = null;
      this.#reconnectAttempts = 0;
      this.#sessionId = msg.sessionId;
      const sameHost = this.#hostInstanceId === msg.hostInstanceId;
      this.#hostInstanceId = msg.hostInstanceId;
      if (!sameHost) {
        this.#lastEventSeq = 0;
        this.#clearPendingEventFrames();
      }
      if (this.#lastBootstrap) {
        this.#lastBootstrap = {
          ...this.#lastBootstrap,
          resume: msg.sessionId,
          continueLatest: false,
        };
      }
      this.onConnectionState?.("connected");
      this.#readyWaiter?.resolve(msg.sessionId);
      this.#readyWaiter = null;
      this.onReady?.(msg.sessionId);
      return;
    }
    if (msg.type === "event") {
      this.#acceptEventFrame(msg);
      return;
    }
    if (msg.type === "resp") {
      const w = this.#rpc.get(msg.id);
      if (!w) return;
      this.#rpc.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.ok) {
        if (!isRpcResult(w.method, msg.value)) {
          w.reject(new Error(`Invalid ${w.method} response`));
          return;
        }
        w.resolve(msg.value);
      }
      else w.reject(new Error(msg.error));
      return;
    }
    if (msg.type === "fatal") {
      this.#fail(msg.message);
    }
  }

  #acceptEventFrame(frame: HostEventFrame): void {
    if (frame.hostInstanceId !== this.#hostInstanceId) {
      this.#recoverFromContinuityFailure("Engine event belongs to a stale host instance");
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
      this.#recoverFromContinuityFailure("Engine event exceeds the mobile continuity buffer");
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

  #retainPendingEventFrames(afterSeq: number): void {
    this.#pendingEventFrames = this.#pendingEventFrames.filter(({ frame }) => frame.seq > afterSeq);
    this.#pendingEventBytes = this.#pendingEventFrames.reduce((total, item) => total + item.bytes, 0);
  }

  #deliverEventFrame(frame: HostEventFrame): void {
    if (frame.seq <= this.#lastEventSeq || !isUIEvent(frame.event)) return;
    this.#lastEventSeq = frame.seq;
    for (const sink of this.#sinks) sink(frame.event as UIEvent);
  }

  async #reconcileEventGap(): Promise<void> {
    if (this.#replayInFlight || !this.#hostInstanceId || !this.#ready) return;
    this.#replayInFlight = true;
    try {
      const result = await this.rpc("replayEvents", {
        hostInstanceId: this.#hostInstanceId,
        afterSeq: this.#lastEventSeq,
      }) as HostReplayResult;
      if (result.truncated || result.hostInstanceId !== this.#hostInstanceId) {
        await this.#resyncFromSnapshot();
        return;
      }
      const frames = [...result.events, ...this.#pendingEventFrames.map(({ frame }) => frame)].sort((a, b) => a.seq - b.seq);
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
      this.#recoverFromContinuityFailure(
        `Engine event replay failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#replayInFlight = false;
      if (this.#ready && this.#pendingEventFrames.some(({ frame }) => frame.seq > this.#lastEventSeq)) {
        void this.#reconcileEventGap();
      }
    }
  }

  async #resyncFromSnapshot(): Promise<void> {
    const value = await this.rpc("snapshot");
    if (!isEngineSnapshot(value)) throw new Error("Invalid engine resync snapshot");
    if (value.hostInstanceId !== this.#hostInstanceId || !Number.isSafeInteger(value.lastEventSeq)) {
      throw new Error("Engine resync snapshot cursor mismatch");
    }
    this.#lastEventSeq = value.lastEventSeq ?? this.#lastEventSeq;
    this.#retainPendingEventFrames(this.#lastEventSeq);
    this.#snapshot = value;
    this.onReady?.(value.sessionId);
  }

  #handleClose(socket: WebSocket, code: number, reason: string): void {
    if (this.#socket !== socket) return;
    this.#stopKeepalive();
    this.#ready = false;
    this.#socket = null;
    const err = new Error(`Engine disconnected (${code})${reason ? `: ${reason}` : ""}`);
    this.#readyWaiter?.reject(err);
    this.#readyWaiter = null;
    for (const w of this.#rpc.values()) { clearTimeout(w.timer); w.reject(err); }
    this.#rpc.clear();
    this.#rejectRelayRequests(err);
    const terminal = TERMINAL_CLOSE_CODES.has(code) || (code === 1000 && reason === "desktop-control");
    this.#terminallyDisconnected = terminal;
    if (!this.#closed && !terminal && this.#opts.autoReconnect !== false) {
      this.onConnectionState?.("reconnecting");
      this.#scheduleReconnect();
    } else if (!this.#closed) {
      this.onConnectionState?.("disconnected");
      this.onFatal?.(`Engine disconnected (${code})${reason ? `: ${reason}` : ""}`);
    }
    this.onDisconnect?.();
  }

  async #reconnectWithLast(): Promise<string> {
    if (this.#closed) throw new Error("Engine connection is closed");
    const socket = await this.#openSocket("reconnecting");
    this.#snapshot = null;
    if (this.#lastBootstrap) this.#sendBootstrap(this.#lastBootstrap);
    try {
      return await this.#waitForReady();
    } catch (error) {
      this.#discardSocket(socket);
      throw error;
    }
  }

  async #openSocket(state: "connecting" | "reconnecting"): Promise<WebSocket> {
    this.onConnectionState?.(state);
    const url = new URL(this.#opts.url);
    url.searchParams.set("token", this.#opts.accessToken);
    const socket = new WebSocket(url.toString());
    const generation = ++this.#socketGeneration;
    this.#socket = socket;
    try {
      await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WebSocket open timeout")), this.#opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
        socket.onopen = () => { clearTimeout(t); resolve(); };
        socket.onerror = () => { clearTimeout(t); reject(new Error("WebSocket connection failed")); };
        socket.onclose = (ev) => { clearTimeout(t); reject(new Error(`WebSocket closed (${ev.code})${ev.reason ? `: ${ev.reason}` : ""}`)); };
      });
    } catch (error) {
      this.#discardSocket(socket);
      throw error;
    }
    if (this.#socket !== socket || this.#socketGeneration !== generation) {
      this.#discardSocket(socket);
      throw new Error("WebSocket connection was superseded");
    }
    socket.onmessage = (ev) => {
      if (this.#socket === socket && this.#socketGeneration === generation) this.#handleMessage(String(ev.data));
    };
    socket.onerror = () => undefined;
    socket.onclose = (ev) => {
      if (this.#socket === socket && this.#socketGeneration === generation) this.#handleClose(socket, ev.code, ev.reason);
    };
    this.#startKeepalive(socket);
    return socket;
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer) return;
    const delay = this.#reconnectDelays[Math.min(this.#reconnectAttempts, this.#reconnectDelays.length - 1)]!;
    this.#reconnectAttempts = Math.min(this.#reconnectAttempts + 1, this.#reconnectDelays.length);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#reconnectWithLast().catch(() => this.#scheduleReconnect());
    }, delay);
  }

  #fail(message: string): void {
    this.#fatal?.(message);
  }

  #recoverFromContinuityFailure(message: string, reconnect = true): void {
    const error = new Error(message);
    if (!reconnect) this.#terminallyDisconnected = true;
    this.#ready = false;
    this.#hostInstanceId = "";
    this.#lastEventSeq = 0;
    this.#clearPendingEventFrames();
    this.#readyWaiter?.reject(error);
    this.#readyWaiter = null;
    for (const waiter of this.#rpc.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#rpc.clear();
    this.#rejectRelayRequests(error);
    const socket = this.#socket;
    if (socket) this.#discardSocket(socket);
    this.#fatal?.(message);
    this.onDisconnect?.();
    if (reconnect && !this.#closed && !this.#terminallyDisconnected && this.#opts.autoReconnect !== false) {
      this.onConnectionState?.("reconnecting");
      this.#scheduleReconnect();
    } else if (!this.#closed) {
      this.onConnectionState?.("disconnected");
    }
  }

  #startKeepalive(socket: WebSocket): void {
    this.#stopKeepalive();
    this.#keepalive = setInterval(() => {
      if (this.#socket === socket && socket.readyState === WebSocket.OPEN) socket.send(KEEPALIVE_PAYLOAD);
    }, KEEPALIVE_MS);
  }
  #stopKeepalive(): void {
    if (this.#keepalive) { clearInterval(this.#keepalive); this.#keepalive = null; }
  }

  #send(payload: string): void {
    const s = this.#socket;
    if (s && s.readyState === WebSocket.OPEN) s.send(payload);
  }

  #discardSocket(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#socketGeneration += 1;
    this.#socket = null;
    this.#ready = false;
    this.#stopKeepalive();
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }

  // EngineClient surface ------------------------------------------------

  events(): AsyncIterable<UIEvent> {
    const client = this;
    return {
      [Symbol.asyncIterator]() {
        const queue: UIEvent[] = [];
        let resolveNext: ((v: IteratorResult<UIEvent>) => void) | null = null;
        let done = false;
        const sink: EventSink = (ev) => {
          if (resolveNext) { resolveNext({ value: ev, done: false }); resolveNext = null; }
          else queue.push(ev);
        };
        client.#sinks.add(sink);
        return {
          next(): Promise<IteratorResult<UIEvent>> {
            if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => { resolveNext = resolve; });
          },
          return(): Promise<IteratorResult<UIEvent>> {
            done = true; client.#sinks.delete(sink);
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  onEvent(handler: (event: UIEvent) => void): () => void {
    this.#sinks.add(handler);
    return () => this.#sinks.delete(handler);
  }

  send(command: EngineCommand): boolean {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return false;
    this.#send(encodeInbound({ op: "send", command }));
    return true;
  }

  async rpc(method: RpcMethod, params?: HostRpcParams): Promise<unknown> {
    if (!this.#ready) throw new Error(`Engine not ready for rpc ${method}`);
    const id = this.#nextRpcId++;
    const timeout = this.#opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#rpc.delete(id); reject(new Error(`rpc ${method} timeout`)); }, timeout);
      this.#rpc.set(id, { method, resolve, reject, timer });
      this.#send(encodeInbound({ op: "rpc", id, method, ...(params ? { params } : {}) }));
    });
  }

  async snapshot(): Promise<EngineSnapshot> {
    if (this.#snapshot) return this.#snapshot;
    const value = await this.rpc("snapshot");
    if (!isEngineSnapshot(value)) throw new Error("Invalid engine snapshot");
    this.#adoptSnapshotCursor(value);
    this.#snapshot = value;
    return value;
  }

  #adoptSnapshotCursor(value: EngineSnapshot): void {
    if (!value.hostInstanceId || !Number.isSafeInteger(value.lastEventSeq)) return;
    if (this.#hostInstanceId && value.hostInstanceId !== this.#hostInstanceId) {
      throw new Error("Engine snapshot belongs to a stale host instance");
    }
    this.#hostInstanceId = value.hostInstanceId;
    this.#lastEventSeq = Math.max(this.#lastEventSeq, value.lastEventSeq ?? 0);
    this.#retainPendingEventFrames(this.#lastEventSeq);
  }

  async listModels(): Promise<ModelSummary[]> {
    const value = await this.rpc("listModels");
    return Array.isArray(value) ? (value as ModelSummary[]) : [];
  }
  async listProviders(): Promise<ProviderInfo[]> {
    const value = await this.rpc("listProviders");
    return Array.isArray(value) ? (value as ProviderInfo[]) : [];
  }
  async listAgents(): Promise<AgentInfo[]> {
    const value = await this.rpc("listAgents");
    return Array.isArray(value) ? (value as AgentInfo[]) : [];
  }
  async listSkills(): Promise<SkillInfo[]> {
    const value = await this.rpc("listSkills");
    return Array.isArray(value) ? (value as SkillInfo[]) : [];
  }

  async finalize(): Promise<void> {
    try { await this.rpc("finalize"); } catch { /* best-effort */ }
  }

  // Relay-only channel (terminal + file listing) — not engine host protocol.

  onRelay(handler: (frame: RelayOutbound) => void): () => void {
    this.#relaySinks.add(handler);
    return () => this.#relaySinks.delete(handler);
  }

  termOpen(cwd: string, cols: number, rows: number): void {
    this.#send(`${JSON.stringify({ relay: "term-open", requestId: this.#relayRequestId("term"), cwd, cols, rows })}\n`);
  }
  termInput(id: string, data: string): void {
    this.#send(`${JSON.stringify({ relay: "term-input", requestId: this.#relayRequestId("term"), id, data })}\n`);
  }
  termResize(id: string, cols: number, rows: number): void {
    this.#send(`${JSON.stringify({ relay: "term-resize", requestId: this.#relayRequestId("term"), id, cols, rows })}\n`);
  }
  termClose(id: string): void {
    this.#send(`${JSON.stringify({ relay: "term-close", requestId: this.#relayRequestId("term"), id })}\n`);
  }
  listFiles(cwd: string, query: string, limit = 40): void {
    this.#send(`${JSON.stringify({ relay: "list-files", requestId: this.#relayRequestId("files"), cwd, query, limit })}\n`);
  }
  async uploadFile(input: { cwd: string; name: string; mimeType?: string; dataBase64: string }): Promise<MobileUploadResult> {
    return this.#relayRequest({ relay: "upload-file", ...input }, "upload", 45_000);
  }

  // Config + memory (relay channel; reuses the desktop config-io/validate) ----

  async configRead(scope: ConfigScope, cwd?: string): Promise<ConfigReadResult | { ok: false; error: string }> {
    return this.#relayRequest({ relay: "config-read", scope, ...(cwd ? { cwd } : {}) });
  }
  async configWrite(request: ConfigWriteRequest): Promise<{ ok: true; config: Record<string, unknown> } | { ok: false; error: string }> {
    return this.#relayRequest({ relay: "config-write", request });
  }
  async memoryRead(scope: ConfigScope, cwd?: string): Promise<MemoryFileResult | { ok: false; error: string }> {
    return this.#relayRequest({ relay: "memory-read", scope, ...(cwd ? { cwd } : {}) });
  }
  async memoryWrite(request: MemoryWriteRequest): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.#relayRequest({ relay: "memory-write", request });
  }
  async git(request: GitRelayRequest): Promise<GitRelayResult> {
    return this.#relayRequest({ relay: "git", request });
  }
  async cloud(request: CloudRelayRequest): Promise<CloudRelayResult> {
    return this.#relayRequest({ relay: "cloud", request }, "cloud");
  }

  #relayRequestId(prefix = "relay"): string {
    return `${prefix}-${this.#nextRelayId++}`;
  }

  #relayRequest<T>(inbound: Record<string, unknown>, prefix = "relay", timeoutMs = 15_000): Promise<T> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Engine not connected"));
    const requestId = this.#relayRequestId(prefix);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.#relayRequests.delete(requestId); reject(new Error(`relay ${requestId} timeout`)); }, timeoutMs);
      this.#relayRequests.set(requestId, {
        resolve: (frame) => {
          const payload = "result" in frame ? frame.result : frame;
          resolve(payload as unknown as T);
        },
        reject,
        timer,
      });
      this.#send(`${JSON.stringify({ ...inbound, requestId })}\n`);
    });
  }

  #rejectRelayRequests(error: Error): void {
    for (const waiter of this.#relayRequests.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#relayRequests.clear();
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
    this.#send(encodeInbound({ op: "shutdown" }));
    this.#rejectRelayRequests(new Error("Engine shut down"));
    this.#stopKeepalive();
    const socket = this.#socket;
    if (socket) this.#discardSocket(socket);
    this.#ready = false;
    this.#hostInstanceId = "";
    this.#lastEventSeq = 0;
    this.#clearPendingEventFrames();
    this.onConnectionState?.("disconnected");
  }
}

export { isRpcResult };
