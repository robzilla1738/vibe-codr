import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { RemoteEngineTransport } from "./remote-engine-transport";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const cachedReady = (sessionId: string) => ({
  type: "ready",
  protocolVersion: 2,
  engineRevision: "test",
  capabilities: ["event-replay"],
  hostInstanceId: "cloud-host",
  sessionId,
});

const agentReady = (sessionId: string | null) => ({
  channel: "agent",
  type: "ready",
  engineSessionId: sessionId,
  ...(sessionId ? { engineReady: cachedReady(sessionId) } : {}),
});

const snapshot = (lastEventSeq: number, hostInstanceId = "cloud-host") => ({
  hostInstanceId,
  lastEventSeq,
  sessionId: "session-cloud",
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

describe("RemoteEngineTransport", () => {
  it("disconnects for desktop close without shutting down the cloud engine", async () => {
    const received: unknown[] = [];
    const { server, url } = await cloudAgent((socket) => {
      socket.send(JSON.stringify(agentReady("session-cloud")));
      socket.on("message", (data: RawData) => received.push(JSON.parse(data.toString())));
    });
    servers.push(server);
    const transport = new RemoteEngineTransport({ url, accessToken: "x".repeat(40) });
    await expect(transport.start({ cwd: "/workspace", resume: "session-cloud" })).resolves.toBe("session-cloud");
    await transport.disposeForQuit();
    expect(received).not.toContainEqual(expect.objectContaining({ channel: "engine", payload: { op: "shutdown" } }));
  });

  it("turns top-level cloud-agent fatal frames into a fatal, not-ready transport", async () => {
    let emitFatal: (() => void) | undefined;
    const { server, url } = await cloudAgent((socket) => {
      socket.send(JSON.stringify(agentReady("session-cloud")));
      emitFatal = () => socket.send(JSON.stringify({ channel: "fatal", message: "engine host died" }));
    });
    servers.push(server);
    const transport = new RemoteEngineTransport({ url, accessToken: "x".repeat(40) });
    const fatal = new Promise<string>((resolve) => { transport.onFatal = resolve; });
    await transport.start({ cwd: "/workspace", resume: "session-cloud" });
    emitFatal?.();
    await expect(fatal).resolves.toBe("engine host died");
    expect(transport.isReady).toBe(false);
    await expect(transport.rpc("snapshot")).rejects.toThrow("not ready");
  });

  it("hydrates legacy existing-session agents from a snapshot before releasing racing events", async () => {
    const { server, url } = await cloudAgent((socket) => {
      socket.send(JSON.stringify({ channel: "agent", type: "ready", engineSessionId: "session-cloud" }));
      socket.on("message", (data: RawData) => {
        const frame = JSON.parse(data.toString()) as { channel?: string; payload?: { op?: string; id?: number } };
        if (frame.channel === "engine" && frame.payload?.op === "rpc") {
          socket.send(JSON.stringify({
            channel: "engine",
            payload: {
              type: "event",
              hostInstanceId: "cloud-host",
              seq: 6,
              event: { type: "notice", level: "info", message: "continued" },
            },
          }));
          socket.send(JSON.stringify({
            channel: "engine",
            payload: { type: "resp", id: frame.payload.id, ok: true, value: snapshot(5) },
          }));
        }
      });
    }, false);
    servers.push(server);
    const transport = new RemoteEngineTransport({ url, accessToken: "x".repeat(40) });
    const events: unknown[] = [];
    let readyInfo: Parameters<NonNullable<typeof transport.onReady>>[1];
    transport.onEvent = (event) => events.push(event);
    transport.onReady = (_sessionId, info) => { readyInfo = info; };

    await expect(transport.start({ cwd: "/workspace", resume: "session-cloud" })).resolves.toBe("session-cloud");
    expect(events).toEqual([{ type: "notice", level: "info", message: "continued" }]);
    expect(readyInfo).toEqual({
      protocolVersion: 2,
      engineRevision: "legacy-cloud-agent",
      capabilities: ["event-replay"],
      hostInstanceId: "cloud-host",
    });
    await transport.disposeForQuit();
  });

  it("seeds cached versioned sessions from snapshot before releasing racing events", async () => {
    const { server, url } = await cloudAgent((socket) => {
      socket.send(JSON.stringify(agentReady("session-cloud")));
      socket.on("message", (data: RawData) => {
        const frame = JSON.parse(data.toString()) as { channel?: string; payload?: { op?: string; id?: number; method?: string } };
        if (frame.channel === "engine" && frame.payload?.op === "rpc" && frame.payload.method === "snapshot") {
          socket.send(JSON.stringify({
            channel: "engine",
            payload: {
              type: "event",
              hostInstanceId: "cloud-host",
              seq: 6,
              event: { type: "notice", level: "info", message: "continued" },
            },
          }));
          socket.send(JSON.stringify({
            channel: "engine",
            payload: { type: "resp", id: frame.payload.id, ok: true, value: snapshot(5) },
          }));
        }
      });
    }, false);
    servers.push(server);
    const transport = new RemoteEngineTransport({ url, accessToken: "x".repeat(40) });
    const events: unknown[] = [];
    transport.onEvent = (event) => events.push(event);

    await expect(transport.start({ cwd: "/workspace", resume: "session-cloud" })).resolves.toBe("session-cloud");
    expect(events).toEqual([{ type: "notice", level: "info", message: "continued" }]);
    await transport.disposeForQuit();
  });

  it("drops attempt-scoped pending frames before adopting a replacement host", async () => {
    let connection = 0;
    const { server, url } = await cloudAgent((socket) => {
      connection += 1;
      const attempt = connection;
      socket.send(JSON.stringify({ channel: "agent", type: "ready", engineSessionId: "session-cloud" }));
      socket.on("message", (data: RawData) => {
        const frame = JSON.parse(data.toString()) as { channel?: string; payload?: { op?: string; id?: number; method?: string } };
        if (frame.channel !== "engine" || frame.payload?.op !== "rpc" || frame.payload.method !== "snapshot") return;
        if (attempt === 1) {
          socket.send(JSON.stringify({
            channel: "engine",
            payload: {
              type: "event",
              hostInstanceId: "host-one",
              seq: 1,
              event: { type: "notice", level: "info", message: "stale" },
            },
          }));
          socket.terminate();
          return;
        }
        socket.send(JSON.stringify({
          channel: "engine",
          payload: { type: "resp", id: frame.payload.id, ok: true, value: snapshot(0, "host-two") },
        }));
        socket.send(JSON.stringify({
          channel: "engine",
          payload: {
            type: "event",
            hostInstanceId: "host-two",
            seq: 1,
            event: { type: "notice", level: "info", message: "fresh" },
          },
        }));
      });
    }, false);
    servers.push(server);
    const transport = new RemoteEngineTransport({ url, accessToken: "x".repeat(40) });
    const events: unknown[] = [];
    transport.onEvent = (event) => events.push(event);

    await expect(transport.start({ cwd: "/workspace", resume: "session-cloud" })).resolves.toBe("session-cloud");
    expect(connection).toBe(2);
    expect(events).toEqual([{ type: "notice", level: "info", message: "fresh" }]);
    await transport.disposeForQuit();
  });

  it("disconnects when one pending event exceeds the continuity byte budget", async () => {
    let cloudSocket!: WebSocket;
    const { server, url } = await cloudAgent((socket) => {
      cloudSocket = socket;
      socket.send(JSON.stringify(agentReady("session-cloud")));
    });
    servers.push(server);
    const transport = new RemoteEngineTransport({ url, accessToken: "x".repeat(40) });
    await transport.start({ cwd: "/workspace", resume: "session-cloud" });
    const fatal = new Promise<string>((resolve) => { transport.onFatal = resolve; });
    cloudSocket.send(JSON.stringify({
      channel: "engine",
      payload: {
        type: "event",
        hostInstanceId: "cloud-host",
        seq: 2,
        event: { type: "notice", level: "info", message: "x".repeat(8 * 1024 * 1024) },
      },
    }));

    await expect(fatal).resolves.toContain("larger than the continuity buffer");
    expect(transport.isReady).toBe(false);
  });

  it("rejects a stale sandbox that is already running another session", async () => {
    const { server, url } = await cloudAgent((socket) => {
      socket.send(JSON.stringify(agentReady("session-stale")));
    });
    servers.push(server);
    const transport = new RemoteEngineTransport({ url, accessToken: "x".repeat(40) });
    await expect(transport.start({ cwd: "/workspace", resume: "session-expected" }))
      .rejects.toThrow(/session mismatch.*session-expected.*session-stale/i);
    expect(transport.isReady).toBe(false);
  });

  it("rejects a fresh cloud bootstrap that creates a replacement session", async () => {
    const { server, url } = await cloudAgent((socket) => {
      socket.send(JSON.stringify(agentReady(null)));
      socket.on("message", (data: RawData) => {
        const frame = JSON.parse(data.toString()) as { channel?: string; payload?: { op?: string } };
        if (frame.channel === "engine" && frame.payload?.op === "bootstrap") {
          socket.send(JSON.stringify({
            channel: "engine",
            payload: {
              type: "ready",
              protocolVersion: 2,
              engineRevision: "test",
              capabilities: ["event-replay"],
              hostInstanceId: "cloud-host",
              sessionId: "session-replacement",
            },
          }));
        }
      });
    });
    servers.push(server);
    const transport = new RemoteEngineTransport({ url, accessToken: "x".repeat(40) });
    await expect(transport.start({ cwd: "/workspace", resume: "session-expected" }))
      .rejects.toThrow(/session mismatch.*session-expected.*session-replacement/i);
    expect(transport.isReady).toBe(false);
  });

  it("terminates a connected socket when the ready handshake times out", async () => {
    let closed!: Promise<void>;
    const { server, url } = await cloudAgent((socket) => {
      closed = new Promise((resolve) => socket.once("close", () => resolve()));
    });
    servers.push(server);
    const transport = new RemoteEngineTransport({
      url,
      accessToken: "x".repeat(40),
      readyTimeoutMs: 20,
    });
    await expect(transport.start({ cwd: "/workspace", resume: "session-cloud" }))
      .rejects.toThrow("timed out waiting for ready");
    await expect(closed).resolves.toBeUndefined();
    expect(transport.isReady).toBe(false);
  });

  it("waits for the cloud daemon to stop the engine before releasing ownership", async () => {
    let acknowledgeDetach!: () => void;
    let detachReceived!: Promise<void>;
    const { server, url } = await cloudAgent((socket) => {
      socket.send(JSON.stringify(agentReady("session-cloud")));
      detachReceived = new Promise<void>((resolve) => {
        socket.on("message", (data: RawData) => {
          const frame = JSON.parse(data.toString()) as { channel?: string; op?: string };
          if (frame.channel === "agent" && frame.op === "detach-engine") {
            acknowledgeDetach = () => socket.send(JSON.stringify({ channel: "agent", type: "detached" }));
            resolve();
          }
        });
      });
    });
    servers.push(server);
    const transport = new RemoteEngineTransport({ url, accessToken: "x".repeat(40) });
    await transport.start({ cwd: "/workspace", resume: "session-cloud" });

    let completed = false;
    const detach = transport.detachForHandoff().then(() => { completed = true; });
    await detachReceived;
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(transport.isRunning).toBe(true);

    acknowledgeDetach();
    await detach;
    expect(transport.isRunning).toBe(false);
  });

  it("routes terminal and bounded file-preview channels through the authenticated agent", async () => {
    const received: Array<Record<string, unknown>> = [];
    const { server, url } = await cloudAgent((socket) => {
      socket.send(JSON.stringify(agentReady("session-cloud")));
      socket.on("message", (data: RawData) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(frame);
        if (frame.channel === "terminal" && frame.op === "create") {
          socket.send(JSON.stringify({ channel: "terminal", type: "created", id: frame.id, pid: 123 }));
          socket.send(JSON.stringify({ channel: "terminal", type: "data", id: frame.id, data: "cloud prompt$ " }));
        }
        if (frame.channel === "file" && frame.op === "read") {
          socket.send(JSON.stringify({
            channel: "file",
            requestId: frame.requestId,
            ok: true,
            contentBase64: Buffer.from("remote file contents").toString("base64"),
          }));
        }
        if (frame.channel === "file" && frame.op === "write") {
          socket.send(JSON.stringify({ channel: "file", requestId: frame.requestId, ok: true }));
        }
      });
    });
    servers.push(server);
    const transport = new RemoteEngineTransport({ url, accessToken: "x".repeat(40) });
    const terminalEvent = new Promise((resolve) => { transport.onTerminalEvent = resolve; });
    await transport.start({ cwd: "/home/user/vibe/project", resume: "session-cloud" });

    const opened = await transport.terminalOpen({ cwd: "/home/user/vibe/project", cols: 100, rows: 30 });
    expect(opened).toMatchObject({ ok: true, cwd: "/home/user/vibe/project", reused: false, shell: "/bin/bash" });
    if (!opened.ok) throw new Error(opened.error);
    await expect(terminalEvent).resolves.toMatchObject({ type: "data", id: opened.id, data: "cloud prompt$ ", sequence: 1 });
    expect(transport.terminalWrite(opened.id, "pwd\n")).toEqual({ ok: true });
    expect(transport.terminalResize(opened.id, 120, 40)).toEqual({ ok: true });
    await expect(transport.readTextFile("README.md", 6)).resolves.toEqual({ ok: true, text: "remote", truncated: true });
    await expect(transport.writeFile(".vibe/clipboard/image.png", Buffer.from("png"), 0o600)).resolves.toEqual({ ok: true });
    await expect(transport.readTextFile("../outside", 6)).resolves.toEqual({ ok: false, error: "Invalid remote file path" });
    expect(received).toContainEqual(expect.objectContaining({ channel: "terminal", op: "create", cols: 100, rows: 30 }));
    expect(received).toContainEqual(expect.objectContaining({ channel: "terminal", op: "write", id: opened.id, data: "pwd\n" }));
    expect(received).toContainEqual(expect.objectContaining({ channel: "file", op: "read", path: "README.md" }));
    expect(received).toContainEqual(expect.objectContaining({
      channel: "file",
      op: "write",
      path: ".vibe/clipboard/image.png",
      contentBase64: Buffer.from("png").toString("base64"),
      mode: 0o600,
    }));
    await transport.disposeForQuit();
  });

  it("reattaches its deterministic terminal and returns bounded replay after reconnect", async () => {
    const { server, url } = await cloudAgent((socket) => {
      socket.send(JSON.stringify(agentReady("session-cloud")));
      socket.on("message", (data: RawData) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.channel === "terminal" && frame.op === "create") {
          socket.send(JSON.stringify({ channel: "error", requestId: frame.requestId, error: "terminal already exists" }));
        } else if (frame.channel === "terminal" && frame.op === "attach") {
          socket.send(JSON.stringify({ channel: "terminal", type: "replay", id: frame.id, data: "persisted output\n" }));
        }
      });
    });
    servers.push(server);
    const transport = new RemoteEngineTransport({ url, accessToken: "x".repeat(40) });
    await transport.start({ cwd: "/home/user/vibe/project", resume: "session-cloud" });

    await expect(transport.terminalOpen({ cwd: "/home/user/vibe/project", cols: 80, rows: 24 })).resolves.toMatchObject({
      ok: true,
      reused: true,
      replay: "persisted output\n",
    });
    await transport.disposeForQuit();
  });
});

async function cloudAgent(
  onConnection: (socket: WebSocket) => void,
  autoSnapshot = true,
): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    if (autoSnapshot) {
      socket.on("message", (data: RawData) => {
        const frame = JSON.parse(data.toString()) as { channel?: string; payload?: { op?: string; id?: number; method?: string } };
        if (frame.channel === "engine" && frame.payload?.op === "rpc" && frame.payload.method === "snapshot") {
          socket.send(JSON.stringify({
            channel: "engine",
            payload: { type: "resp", id: frame.payload.id, ok: true, value: snapshot(0) },
          }));
        }
      });
    }
    onConnection(socket);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `ws://127.0.0.1:${address.port}` };
}
