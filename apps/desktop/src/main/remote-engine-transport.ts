import WebSocket from "ws";
import type { EngineCommand } from "../shared/commands";
import {
  decodeOutbound,
  type HostInbound,
  type HostOutbound,
  type HostRpcParams,
  type RpcMethod,
} from "../shared/protocol";
import type { EngineStartOptions } from "./engine-bridge";
import type { EngineTransport } from "./engine-transport";
import { isRpcResult } from "../shared/runtime-guards";

const READY_TIMEOUT_MS = 45_000;
const RPC_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const CONNECT_RETRY_DELAYS_MS = [250, 750];
const KEEPALIVE_INTERVAL_MS = 15_000;

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
  #readyWaiters: Array<{ resolve: (id: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  #agentReady: ((sessionId: string | null) => void) | null = null;
  #existingSessionId: string | null | undefined;
  #detachWaiter: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  #keepalive: NodeJS.Timeout | null = null;
  #connecting = false;

  onEvent: ((event: unknown) => void) | null = null;
  onFatal: ((message: string) => void) | null = null;
  onReady: ((sessionId: string) => void) | null = null;

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
    this.#existingSessionId = undefined;
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
      this.#rejectAll(new Error(`Cloud engine disconnected (${code})${reason.length ? `: ${reason.toString()}` : ""}`));
      if (!expected && !this.#connecting) this.onFatal?.(`Cloud engine disconnected (${code})`);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => { this.#startKeepalive(socket); resolve(); });
      socket.once("error", reject);
      socket.once("close", (code) => reject(new Error(`Cloud engine disconnected (${code}) during connection`)));
    });
    const existing = await new Promise<string | null>((resolve) => {
      if (this.#existingSessionId !== undefined) { resolve(this.#existingSessionId); return; }
      const timer = setTimeout(() => { this.#agentReady = null; resolve(null); }, 3_000);
      this.#agentReady = (sessionId) => { clearTimeout(timer); this.#agentReady = null; resolve(sessionId); };
    });
    if (existing) {
      if (options.resume && existing !== options.resume) {
        await this.disposeForQuit();
        throw new Error(`Cloud sandbox session mismatch: expected ${options.resume}, received ${existing}`);
      }
      this.#ready = true;
      this.#sessionId = existing;
      this.onReady?.(existing);
      return existing;
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

  rpc(method: RpcMethod, params?: HostRpcParams): Promise<unknown> {
    if (!this.isReady) return Promise.reject(new Error("Cloud engine not ready"));
    const id = this.#nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#rpc.delete(id);
        reject(new Error(`Cloud RPC ${method} timed out`));
      }, this.options.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
      this.#rpc.set(id, { method, resolve, reject, timer });
      this.#sendHost({ op: "rpc", id, method, ...(params ? { params } : {}) });
    });
  }

  async stop(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
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

  #sendFrame(socket: WebSocket, frame: unknown): void {
    const data = JSON.stringify(frame);
    if (Buffer.byteLength(data) > MAX_FRAME_BYTES) throw new Error("Cloud engine frame exceeds 32 MiB");
    socket.send(data);
  }

  #handleFrame(raw: string): void {
    let frame: { channel?: unknown; payload?: unknown; type?: unknown; engineSessionId?: unknown; message?: unknown; error?: unknown };
    try { frame = JSON.parse(raw); } catch { this.#fail("Cloud agent emitted malformed JSON"); return; }
    if (frame.channel === "agent" && frame.type === "ready") {
      const sessionId = typeof frame.engineSessionId === "string" ? frame.engineSessionId : null;
      this.#existingSessionId = sessionId;
      this.#agentReady?.(sessionId);
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

  #handleHost(msg: HostOutbound): void {
    if (msg.type === "ready") {
      this.#ready = true;
      this.#sessionId = msg.sessionId;
      this.onReady?.(msg.sessionId);
      for (const waiter of this.#readyWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(msg.sessionId); }
      return;
    }
    if (msg.type === "event") { this.onEvent?.(msg.event); return; }
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
    this.#stopKeepalive();
    if (!this.#connecting) this.onFatal?.(message);
    this.#rejectAll(new Error(message));
    socket?.terminate();
  }

  async #discardSocket(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
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
    for (const waiter of this.#readyWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
    if (this.#detachWaiter) {
      clearTimeout(this.#detachWaiter.timer);
      this.#detachWaiter.reject(error);
      this.#detachWaiter = null;
    }
  }
}

function isTransientDisconnect(error: unknown): boolean {
  const value = error instanceof Error ? error.message : String(error);
  return /\b1006\b|ECONNRESET|EPIPE|socket hang up|unexpected server response|network/i.test(value);
}
