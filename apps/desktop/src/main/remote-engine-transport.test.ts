import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { RemoteEngineTransport } from "./remote-engine-transport";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("RemoteEngineTransport", () => {
  it("disconnects for desktop close without shutting down the cloud engine", async () => {
    const received: unknown[] = [];
    const { server, url } = await cloudAgent((socket) => {
      socket.send(JSON.stringify({ channel: "agent", type: "ready", engineSessionId: "session-cloud" }));
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
      socket.send(JSON.stringify({ channel: "agent", type: "ready", engineSessionId: "session-cloud" }));
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

  it("rejects a stale sandbox that is already running another session", async () => {
    const { server, url } = await cloudAgent((socket) => {
      socket.send(JSON.stringify({ channel: "agent", type: "ready", engineSessionId: "session-stale" }));
    });
    servers.push(server);
    const transport = new RemoteEngineTransport({ url, accessToken: "x".repeat(40) });
    await expect(transport.start({ cwd: "/workspace", resume: "session-expected" }))
      .rejects.toThrow(/session mismatch.*session-expected.*session-stale/i);
    expect(transport.isReady).toBe(false);
  });

  it("rejects a fresh cloud bootstrap that creates a replacement session", async () => {
    const { server, url } = await cloudAgent((socket) => {
      socket.send(JSON.stringify({ channel: "agent", type: "ready", engineSessionId: null }));
      socket.on("message", (data: RawData) => {
        const frame = JSON.parse(data.toString()) as { channel?: string; payload?: { op?: string } };
        if (frame.channel === "engine" && frame.payload?.op === "bootstrap") {
          socket.send(JSON.stringify({
            channel: "engine",
            payload: { type: "ready", sessionId: "session-replacement" },
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
      socket.send(JSON.stringify({ channel: "agent", type: "ready", engineSessionId: "session-cloud" }));
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
      socket.send(JSON.stringify({ channel: "agent", type: "ready", engineSessionId: "session-cloud" }));
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
      socket.send(JSON.stringify({ channel: "agent", type: "ready", engineSessionId: "session-cloud" }));
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

async function cloudAgent(onConnection: (socket: WebSocket) => void): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", onConnection);
  const address = server.address() as AddressInfo;
  return { server, url: `ws://127.0.0.1:${address.port}` };
}
