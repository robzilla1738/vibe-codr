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
  socket.receive({ type: "ready", sessionId: "session-1" });
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
    const { client, socket: first } = await connectedClient();
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
    second.receive({ type: "ready", sessionId: "session-1" });
    first.receive({ type: "event", event: { type: "notice", level: "info", message: "stale" } });

    expect(notices).toEqual([]);
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
    second.receive({ type: "ready", sessionId: "session-1" });
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
