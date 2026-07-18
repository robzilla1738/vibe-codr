// Remote engine client for the mobile renderer. Speaks the exact same NDJSON
// host protocol as the Electron `RemoteEngineTransport` / `EngineBridge`
// (bootstrap / send / rpc / shutdown), over React Native's built-in WebSocket.
// Reuses the shared `encodeInbound` / `decodeOutbound` / guards so the wire
// contract is byte-identical to the desktop shell — 1:1 by construction.
import type { EngineCommand } from "@shared/commands";
import { encodeInbound, decodeOutbound, type HostOutbound, type RpcMethod, type HostRpcParams } from "@shared/protocol";
import { isUIEvent } from "@shared/protocol";
import { isEngineSnapshot, isRpcResult } from "@shared/runtime-guards";
import { isRelayOutbound, type CloudRelayRequest, type CloudRelayResult, type GitRelayRequest, type GitRelayResult, type RelayOutbound } from "@relay/protocol";
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
}

const READY_TIMEOUT_MS = 45_000;
const RPC_TIMEOUT_MS = 30_000;
const KEEPALIVE_MS = 15_000;
const KEEPALIVE_PAYLOAD = '{"op":"ping"}\n';
const RECONNECT_DELAYS_MS = [500, 1500, 5000];

type EventSink = (event: UIEvent) => void;
export type RemoteConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

export class RemoteEngineClient {
  #socket: WebSocket | null = null;
  #sessionId = "";
  #ready = false;
  #nextRpcId = 1;
  #rpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #readyWaiter: { resolve: (id: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  #keepalive: ReturnType<typeof setInterval> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempts = 0;
  #lastBootstrap: { cwd: string; resume?: string; continueLatest?: boolean; model?: string; mode?: string } | null = null;
  #sinks = new Set<EventSink>();
  #fatal: ((msg: string) => void) | null = null;
  #snapshot: EngineSnapshot | null = null;
  #opts: RemoteClientOptions;
  #closed = false;

  onFatal: ((message: string) => void) | null = null;
  onReady: ((sessionId: string) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  onConnectionState: ((state: RemoteConnectionState) => void) | null = null;
  #relaySinks = new Set<(frame: RelayOutbound) => void>();
  #relayRequests = new Map<string, (frame: RelayOutbound) => void>();

  constructor(opts: RemoteClientOptions) {
    this.#opts = opts;
    this.#fatal = (msg) => this.onFatal?.(msg);
  }

  get isReady(): boolean { return this.#ready; }
  get sessionId(): string { return this.#sessionId; }

  async connect(): Promise<string> {
    this.#closed = false;
    this.onConnectionState?.("connecting");
    const url = new URL(this.#opts.url);
    url.searchParams.set("token", this.#opts.accessToken);
    const socket = new WebSocket(url.toString());
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WebSocket open timeout")), this.#opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
      socket.onopen = () => { clearTimeout(t); resolve(); };
      socket.onerror = () => { clearTimeout(t); reject(new Error("WebSocket connection failed")); };
      socket.onclose = (ev) => { clearTimeout(t); reject(new Error(`WebSocket closed (${ev.code})`)); };
    });
    socket.onmessage = (ev) => this.#handleMessage(String(ev.data));
    socket.onerror = () => this.#fail("Engine connection error");
    socket.onclose = (ev) => this.#handleClose(ev.code, ev.reason);
    this.#startKeepalive();
    this.#lastBootstrap = { cwd: this.#opts.cwd, resume: this.#opts.resume, continueLatest: this.#opts.continueLatest, model: this.#opts.model, mode: this.#opts.mode };
    this.#sendBootstrap(this.#lastBootstrap);
    return this.#waitForReady();
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
        const relayKey = frame.relay === "cloud-result" ? `${frame.relay}:${frame.requestId}` : frame.relay;
        const waiter = this.#relayRequests.get(relayKey);
        if (waiter) { this.#relayRequests.delete(relayKey); waiter(frame); }
        for (const sink of this.#relaySinks) sink(frame);
        continue;
      }
      const msg = decodeOutbound(line);
      if (!msg) continue;
      this.#dispatch(msg);
    }
  }

  #dispatch(msg: HostOutbound): void {
    if (msg.type === "ready") {
      this.#ready = true;
      this.#sessionId = msg.sessionId;
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
      if (isUIEvent(msg.event)) {
        const ev = msg.event as UIEvent;
        for (const sink of this.#sinks) sink(ev);
      }
      return;
    }
    if (msg.type === "resp") {
      const w = this.#rpc.get(msg.id);
      if (!w) return;
      this.#rpc.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.ok) w.resolve(msg.value);
      else w.reject(new Error(msg.error));
      return;
    }
    if (msg.type === "fatal") {
      this.#fail(msg.message);
    }
  }

  #handleClose(code: number, reason: string): void {
    this.#stopKeepalive();
    this.#ready = false;
    this.#socket = null;
    const err = new Error(`Engine disconnected (${code})${reason ? `: ${reason}` : ""}`);
    this.#readyWaiter?.reject(err);
    this.#readyWaiter = null;
    for (const w of this.#rpc.values()) { clearTimeout(w.timer); w.reject(err); }
    this.#rpc.clear();
    if (!this.#closed && this.#opts.autoReconnect !== false) {
      this.onConnectionState?.("reconnecting");
      this.#scheduleReconnect();
    } else if (!this.#closed) {
      this.onConnectionState?.("disconnected");
      this.onFatal?.(`Engine disconnected (${code})`);
    }
    this.onDisconnect?.();
  }

  async #reconnectWithLast(): Promise<string> {
    this.#closed = false;
    this.onConnectionState?.("reconnecting");
    const url = new URL(this.#opts.url);
    url.searchParams.set("token", this.#opts.accessToken);
    const socket = new WebSocket(url.toString());
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WebSocket open timeout")), this.#opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
      socket.onopen = () => { clearTimeout(t); resolve(); };
      socket.onerror = () => { clearTimeout(t); reject(new Error("WebSocket connection failed")); };
      socket.onclose = (ev) => { clearTimeout(t); reject(new Error(`WebSocket closed (${ev.code})`)); };
    });
    socket.onmessage = (ev) => this.#handleMessage(String(ev.data));
    socket.onerror = () => this.#fail("Engine connection error");
    socket.onclose = (ev) => this.#handleClose(ev.code, ev.reason);
    this.#startKeepalive();
    this.#snapshot = null;
    if (this.#lastBootstrap) this.#sendBootstrap(this.#lastBootstrap);
    return this.#waitForReady();
  }

  #scheduleReconnect(): void {
    const attempt = this.#reconnectAttempts;
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      this.onConnectionState?.("disconnected");
      this.onFatal?.(`Engine reconnection failed after ${attempt} attempts`);
      return;
    }
    const delay = RECONNECT_DELAYS_MS[attempt]!;
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#reconnectWithLast().then(() => { this.#reconnectAttempts = 0; }).catch(() => this.#scheduleReconnect());
    }, delay);
  }

  #fail(message: string): void {
    this.#fatal?.(message);
  }

  #startKeepalive(): void {
    this.#stopKeepalive();
    this.#keepalive = setInterval(() => {
      if (this.#socket?.readyState === WebSocket.OPEN) this.#send(KEEPALIVE_PAYLOAD);
    }, KEEPALIVE_MS);
  }
  #stopKeepalive(): void {
    if (this.#keepalive) { clearInterval(this.#keepalive); this.#keepalive = null; }
  }

  #send(payload: string): void {
    const s = this.#socket;
    if (s && s.readyState === WebSocket.OPEN) s.send(payload);
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
      this.#rpc.set(id, { resolve, reject, timer });
      this.#send(encodeInbound({ op: "rpc", id, method, ...(params ? { params } : {}) }));
    });
  }

  async snapshot(): Promise<EngineSnapshot> {
    if (this.#snapshot) return this.#snapshot;
    const value = await this.rpc("snapshot");
    if (!isEngineSnapshot(value)) throw new Error("Invalid engine snapshot");
    this.#snapshot = value;
    return value;
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
    this.#send(`${JSON.stringify({ relay: "term-open", cwd, cols, rows })}\n`);
  }
  termInput(id: string, data: string): void {
    this.#send(`${JSON.stringify({ relay: "term-input", id, data })}\n`);
  }
  termResize(id: string, cols: number, rows: number): void {
    this.#send(`${JSON.stringify({ relay: "term-resize", id, cols, rows })}\n`);
  }
  termClose(id: string): void {
    this.#send(`${JSON.stringify({ relay: "term-close", id })}\n`);
  }
  listFiles(cwd: string, query: string, limit = 40): void {
    this.#send(`${JSON.stringify({ relay: "list-files", cwd, query, limit })}\n`);
  }

  // Config + memory (relay channel; reuses the desktop config-io/validate) ----

  async configRead(scope: ConfigScope, cwd?: string): Promise<ConfigReadResult | { ok: false; error: string }> {
    return this.#relayRequest("config-read-result", { relay: "config-read", scope, ...(cwd ? { cwd } : {}) });
  }
  async configWrite(request: ConfigWriteRequest): Promise<{ ok: true; config: Record<string, unknown> } | { ok: false; error: string }> {
    return this.#relayRequest("config-write-result", { relay: "config-write", request });
  }
  async memoryRead(scope: ConfigScope, cwd?: string): Promise<MemoryFileResult | { ok: false; error: string }> {
    return this.#relayRequest("memory-read-result", { relay: "memory-read", scope, ...(cwd ? { cwd } : {}) });
  }
  async memoryWrite(request: MemoryWriteRequest): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.#relayRequest("memory-write-result", { relay: "memory-write", request });
  }
  async git(request: GitRelayRequest): Promise<GitRelayResult> {
    return this.#relayRequest("git-result", { relay: "git", request });
  }
  async cloud(request: CloudRelayRequest): Promise<CloudRelayResult> {
    const requestId = `cloud-${this.#nextRpcId++}`;
    return this.#relayRequest(`cloud-result:${requestId}`, { relay: "cloud", requestId, request });
  }

  #relayRequest<T>(resultRelay: string, inbound: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.#relayRequests.delete(resultRelay); reject(new Error(`relay ${resultRelay} timeout`)); }, 15_000);
      this.#relayRequests.set(resultRelay, (frame) => {
        clearTimeout(timer);
        const payload = "result" in frame ? frame.result : frame;
        resolve(payload as unknown as T);
      });
      this.#send(`${JSON.stringify(inbound)}\n`);
    });
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
    this.#send(encodeInbound({ op: "shutdown" }));
    this.#stopKeepalive();
    this.#socket?.close();
    this.#socket = null;
    this.#ready = false;
    this.onConnectionState?.("disconnected");
  }
}

export { isRpcResult };
