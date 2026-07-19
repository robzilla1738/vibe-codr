import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRelayInbound, isRelayOutbound } from "../../../relay/protocol";
import { RemoteEngineClient } from "./RemoteEngineClient";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static autoOpen = true;

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    if (MockWebSocket.autoOpen) queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void { this.sent.push(data); }

  close(code = 1000, reason = ""): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: `${JSON.stringify(frame)}\n` });
  }

  failOpen(): void {
    this.onerror?.();
  }
}

const readyFrame = (sessionId = "session-1") => ({
  type: "ready",
  protocolVersion: 2,
  engineRevision: "test",
  capabilities: ["event-replay"],
  hostInstanceId: "mobile-host",
  sessionId,
});

const snapshotFrame = (lastEventSeq: number) => ({
  hostInstanceId: "mobile-host",
  lastEventSeq,
  sessionId: "session-1",
  model: "fixture/model",
  mode: "execute",
  goal: null,
  history: [],
  tasks: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
  busy: false,
  theme: "default",
  accentColor: "",
  details: "normal",
  mouse: false,
  approvalMode: "ask",
  commandNames: [],
});

async function connectedClient(options: Partial<ConstructorParameters<typeof RemoteEngineClient>[0]> = {}): Promise<{ client: RemoteEngineClient; socket: MockWebSocket }> {
  const client = new RemoteEngineClient({
    url: "ws://relay.test",
    accessToken: "token",
    cwd: "/project",
    autoReconnect: false,
    ...options,
  });
  const connecting = client.connect();
  await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  const socket = MockWebSocket.instances[0]!;
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  socket.receive(readyFrame());
  await expect(connecting).resolves.toBe("session-1");
  return { client, socket };
}

function sentRelayFrames(socket: MockWebSocket): Array<Record<string, unknown>> {
  return socket.sent
    .flatMap((payload) => payload.split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((frame) => typeof frame.relay === "string");
}

describe("RemoteEngineClient relay request correlation", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockWebSocket.autoOpen = true;
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves concurrent same-kind requests correctly in reverse response order", async () => {
    const { client, socket } = await connectedClient();
    const first = client.configRead("global");
    const second = client.configRead("project", "/project");
    const [firstFrame, secondFrame] = sentRelayFrames(socket);

    expect(firstFrame?.requestId).toEqual(expect.any(String));
    expect(secondFrame?.requestId).toEqual(expect.any(String));
    expect(secondFrame?.requestId).not.toBe(firstFrame?.requestId);

    socket.receive({ relay: "config-read-result", requestId: secondFrame!.requestId, result: { ok: true, config: { order: 2 }, path: "/project/.vibe/config.json", raw: "" } });
    socket.receive({ relay: "config-read-result", requestId: firstFrame!.requestId, result: { ok: true, config: { order: 1 }, path: "/global/config.json", raw: "" } });

    await expect(first).resolves.toMatchObject({ ok: true, config: { order: 1 } });
    await expect(second).resolves.toMatchObject({ ok: true, config: { order: 2 } });
    await client.shutdown();
  });

  it("rejects pending relay requests as soon as the socket closes", async () => {
    const { client, socket } = await connectedClient();
    const pending = client.git({ action: "status", cwd: "/project" });

    socket.close(1006, "network lost");

    await expect(pending).rejects.toThrow("Engine disconnected (1006): network lost");
  });

  it("rejects and clears pending relay requests during explicit shutdown", async () => {
    const { client } = await connectedClient();
    const pending = client.memoryRead("global");

    await client.shutdown();

    await expect(pending).rejects.toThrow("Engine shut down");
  });

  it("rejects an incompatible ready handshake immediately and never reconnects it", async () => {
    const client = new RemoteEngineClient({
      url: "ws://relay.test",
      accessToken: "token",
      cwd: "/project",
      autoReconnect: true,
      reconnectDelaysMs: [1],
      readyTimeoutMs: 10_000,
    });
    const connecting = client.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0]!;
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.receive({ ...readyFrame(), protocolVersion: 999 });

    await expect(connecting).rejects.toThrow("protocol 999 is incompatible");
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(MockWebSocket.instances).toHaveLength(1);
    await client.shutdown();
  });

  it("detaches a ready client from stale-host event frames", async () => {
    const { client, socket } = await connectedClient();
    const fatals: string[] = [];
    client.onFatal = (message) => fatals.push(message);
    socket.receive({
      type: "event",
      hostInstanceId: "stale-host",
      seq: 1,
      event: { type: "notice", level: "info", message: "stale" },
    });

    await vi.waitFor(() => expect(fatals.at(-1)).toContain("stale host"));
    expect(client.isReady).toBe(false);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    await client.shutdown();
  });

  it("disconnects instead of retaining an oversized continuity-gap event", async () => {
    const { client, socket } = await connectedClient();
    const fatals: string[] = [];
    client.onFatal = (message) => fatals.push(message);

    socket.receive({
      type: "event",
      hostInstanceId: "mobile-host",
      seq: 2,
      event: { type: "notice", level: "info", message: "x".repeat(8 * 1024 * 1024) },
    });

    await vi.waitFor(() => expect(fatals.at(-1)).toContain("continuity buffer"));
    expect(client.isReady).toBe(false);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    await client.shutdown();
  });

  it("keeps retrying beyond the old three-attempt window", async () => {
    const { client, socket } = await connectedClient({ autoReconnect: true, reconnectDelaysMs: [1] });
    MockWebSocket.autoOpen = false;
    socket.close(1006, "backgrounded");

    for (let expected = 2; expected <= 5; expected += 1) {
      await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(expected));
      const attempt = MockWebSocket.instances.at(-1)!;
      attempt.failOpen();
    }

    expect(MockWebSocket.instances).toHaveLength(5);
    await client.shutdown();
  });

  it("does not reconnect terminal ownership or authentication closes", async () => {
    const { client, socket } = await connectedClient();
    const states: string[] = [];
    const fatals: string[] = [];
    client.onConnectionState = (state) => states.push(state);
    client.onFatal = (message) => fatals.push(message);
    vi.useFakeTimers();

    socket.close(4003, "Desktop has control");
    await vi.advanceTimersByTimeAsync(120_000);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(states.at(-1)).toBe("disconnected");
    expect(fatals.at(-1)).toContain("Desktop has control");
    await client.shutdown();
  });

  it("ignores messages from a stale socket generation after reconnect", async () => {
    const { client, socket: first } = await connectedClient({ autoReconnect: true });
    const notices: string[] = [];
    client.onEvent((event) => {
      if (event.type === "notice") notices.push(event.message);
    });
    vi.useFakeTimers();

    first.close(1006, "network changed");
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    const second = MockWebSocket.instances.at(-1)!;
    await vi.waitFor(() => expect(second.sent.length).toBeGreaterThan(0));
    second.receive(readyFrame());
    first.receive({ type: "event", hostInstanceId: "mobile-host", seq: 1, event: { type: "notice", level: "info", message: "stale" } });

    expect(notices).toEqual([]);
    await client.shutdown();
  });

  it("preserves the protocol cursor when reconnecting to the same host", async () => {
    const { client, socket: first } = await connectedClient({ autoReconnect: true, reconnectDelaysMs: [1] });
    const notices: string[] = [];
    client.onEvent((event) => {
      if (event.type === "notice") notices.push(event.message);
    });
    first.receive({
      type: "event",
      hostInstanceId: "mobile-host",
      seq: 1,
      event: { type: "notice", level: "info", message: "before" },
    });

    first.close(1006, "network changed");
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const second = MockWebSocket.instances[1]!;
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    second.receive(readyFrame());
    second.receive({
      type: "event",
      hostInstanceId: "mobile-host",
      seq: 2,
      event: { type: "notice", level: "info", message: "after" },
    });

    expect(notices).toEqual(["before", "after"]);
    expect(second.sent.map((line) => JSON.parse(line.trim())))
      .not.toContainEqual(expect.objectContaining({ op: "rpc", method: "replayEvents" }));
    await client.shutdown();
  });

  it("seeds event continuity from an authoritative snapshot cursor", async () => {
    const { client, socket } = await connectedClient();
    const notices: string[] = [];
    client.onEvent((event) => {
      if (event.type === "notice") notices.push(event.message);
    });

    const loading = client.snapshot();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const request = JSON.parse(socket.sent[1]!.trim()) as { id: number };
    socket.receive({ type: "resp", id: request.id, ok: true, value: snapshotFrame(10) });
    await expect(loading).resolves.toMatchObject({ lastEventSeq: 10 });
    socket.receive({
      type: "event",
      hostInstanceId: "mobile-host",
      seq: 11,
      event: { type: "notice", level: "info", message: "continued" },
    });

    expect(notices).toEqual(["continued"]);
    expect(socket.sent.map((line) => JSON.parse(line.trim())))
      .not.toContainEqual(expect.objectContaining({ op: "rpc", method: "replayEvents" }));
    await client.shutdown();
  });

  it("invalidates a cached snapshot when the relay reannounces ready after resync", async () => {
    const { client, socket } = await connectedClient();
    const first = client.snapshot();
    const firstRequest = JSON.parse(socket.sent.at(-1)!.trim()) as { id: number; method: string };
    socket.receive({ type: "resp", id: firstRequest.id, ok: true, value: snapshotFrame(4) });
    await expect(first).resolves.toMatchObject({ lastEventSeq: 4 });

    socket.receive(readyFrame());
    const refreshed = client.snapshot();
    const secondRequest = JSON.parse(socket.sent.at(-1)!.trim()) as { id: number; method: string };
    expect(secondRequest.method).toBe("snapshot");
    expect(secondRequest.id).not.toBe(firstRequest.id);
    socket.receive({ type: "resp", id: secondRequest.id, ok: true, value: snapshotFrame(9) });
    await expect(refreshed).resolves.toMatchObject({ lastEventSeq: 9 });
    await client.shutdown();
  });

  it("tears down a failed replay before reconnecting instead of looping the same gap", async () => {
    const { client, socket } = await connectedClient();
    const fatals: string[] = [];
    client.onFatal = (message) => fatals.push(message);

    socket.receive({
      type: "event",
      hostInstanceId: "mobile-host",
      seq: 2,
      event: { type: "notice", level: "info", message: "gap" },
    });
    await vi.waitFor(() => expect(socket.sent.length).toBe(2));
    const replay = JSON.parse(socket.sent[1]!.trim()) as { id: number; method: string };
    expect(replay.method).toBe("replayEvents");
    socket.receive({ type: "resp", id: replay.id, ok: false, error: "replay expired" });

    await vi.waitFor(() => expect(fatals.at(-1)).toContain("replay expired"));
    expect(client.isReady).toBe(false);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(socket.sent.map((line) => JSON.parse(line.trim())).filter((frame) => frame.method === "replayEvents"))
      .toHaveLength(1);
    await client.shutdown();
  });

  it("replaces a possibly stale foreground socket and resumes the exact session", async () => {
    const { client, socket: first } = await connectedClient();
    const pending = client.configRead("global");

    const refreshing = client.refreshAfterForeground();
    await expect(pending).rejects.toThrow("Connection refreshed after returning to foreground");
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const second = MockWebSocket.instances[1]!;
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    expect(JSON.parse(second.sent[0]!.trim())).toMatchObject({ op: "bootstrap", cwd: "/project", resume: "session-1" });
    expect(first.readyState).toBe(MockWebSocket.CLOSED);
    second.receive(readyFrame());
    await expect(refreshing).resolves.toBe("session-1");
    await client.shutdown();
  });

  it("does not foreground-reconnect after desktop ownership ends", async () => {
    const { client, socket } = await connectedClient();
    socket.close(4003, "Desktop has control");

    await expect(client.refreshAfterForeground()).rejects.toThrow("ownership or authentication ended");
    expect(MockWebSocket.instances).toHaveLength(1);
    await client.shutdown();
  });
});

describe("relay correlation guards", () => {
  it("requires bounded non-empty request IDs on requests and one-shot responses", () => {
    expect(isRelayInbound({ relay: "git", request: { action: "status", cwd: "/project" } })).toBe(false);
    expect(isRelayInbound({ relay: "git", requestId: "", request: { action: "status", cwd: "/project" } })).toBe(false);
    expect(isRelayInbound({ relay: "git", requestId: "bad\0id", request: { action: "status", cwd: "/project" } })).toBe(false);
    expect(isRelayInbound({ relay: "git", requestId: "git-1", request: { action: "status", cwd: "/project" } })).toBe(true);

    expect(isRelayOutbound({ relay: "git-result", result: { ok: true, status: null } })).toBe(false);
    expect(isRelayOutbound({ relay: "git-result", requestId: 7, result: { ok: true, status: null } })).toBe(false);
    expect(isRelayOutbound({ relay: "git-result", requestId: "git-1", result: { ok: true, status: null } })).toBe(true);
  });

  it("does not require request IDs on stream events", () => {
    expect(isRelayOutbound({ relay: "term-event", event: {} })).toBe(true);
    expect(isRelayOutbound({ relay: "cloud-status", event: {} })).toBe(true);
  });
});
