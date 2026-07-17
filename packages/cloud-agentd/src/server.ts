import { timingSafeEqual, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { chmod, chown, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, relative, resolve, sep } from "node:path";
import * as pty from "node-pty";
import WebSocket, { WebSocketServer } from "ws";
import { openCloudModelAccess, terminalEnvironmentWithoutModelAccess } from "@vibe/shared/cloud-runtime";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const TERMINAL_REPLAY_BYTES = 1024 * 1024;

type ServerSocket = WebSocket;

interface TerminalSession {
  id: string;
  process: pty.IPty;
  replay: string;
  subscribers: Set<ServerSocket>;
}

interface AgentState {
  host: ChildProcessWithoutNullStreams | null;
  sessionId: string | null;
  startupError: string | null;
  hostClients: Set<ServerSocket>;
  terminals: Map<string, TerminalSession>;
}

interface AgentOptions {
  port?: number;
  accessToken?: string;
  workspaceRoot?: string;
  engineHost?: string;
  expectedSessionId?: string;
  workloadUid?: number;
  workloadGid?: number;
  terminalUid?: number;
  terminalGid?: number;
  cloudProvider?: "e2b" | "vercel";
}

interface WorkloadIdentity { uid: number; gid: number; home: string }

export function startCloudAgent(options: AgentOptions = {}) {
  const port = options.port ?? Number(process.env.VIBE_CLOUD_AGENT_PORT ?? 8787);
  const tokenFile = process.env.VIBE_CLOUD_ACCESS_TOKEN_FILE;
  const accessToken = options.accessToken
    ?? (tokenFile ? readFileSync(tokenFile, "utf8") : process.env.VIBE_CLOUD_ACCESS_TOKEN);
  const workspaceRoot = resolve(options.workspaceRoot ?? process.env.VIBE_WORKSPACE_ROOT ?? "/workspace");
  const engineHost = options.engineHost ?? process.env.VIBE_ENGINE_HOST ?? "vibecodr-engine-host";
  const expectedSessionId = options.expectedSessionId ?? process.env.VIBE_CLOUD_EXPECTED_SESSION_ID;
  const cloudProvider = options.cloudProvider;
  if (cloudProvider !== "e2b" && cloudProvider !== "vercel") {
    throw new Error("Cloud agent requires an explicit e2b or vercel provider identity");
  }
  if (!accessToken || accessToken.length < 32) throw new Error("VIBE_CLOUD_ACCESS_TOKEN must contain at least 32 characters");
  if (tokenFile) rmSync(tokenFile, { force: true });
  delete process.env.VIBE_CLOUD_ACCESS_TOKEN;
  const workload = workloadIdentity(options);
  const terminalWorkload = terminalIdentity(options);
  const isolationRequired = process.env.VIBE_CLOUD_REQUIRE_ISOLATION === "1";
  if (isolationRequired && (
    typeof process.getuid !== "function"
    || process.getuid() !== 0
    || !workload
    || !terminalWorkload
    || workload.uid === terminalWorkload.uid
  )) {
    throw new Error("Cloud control isolation requires a root agent and distinct non-root engine and terminal identities");
  }
  const modelAccessFile = process.env.VIBE_CLOUD_MODEL_ACCESS_FILE;
  if (!modelAccessFile) throw new Error("missing-credential: VIBE_CLOUD_MODEL_ACCESS_FILE is required");
  let modelAccess: ReturnType<typeof openCloudModelAccess>;
  try {
    modelAccess = openCloudModelAccess(
      JSON.parse(readFileSync(modelAccessFile, "utf8")),
      accessToken,
      expectedSessionId,
    );
  } finally {
    rmSync(modelAccessFile, { force: true });
  }
  delete process.env.VIBE_CLOUD_MODEL_ACCESS_FILE;
  const baselineEnvironment = environmentWithoutControlSecrets(process.env);
  const engineEnvironment = { ...baselineEnvironment, ...modelAccess.environment };
  const terminalEnvironment = terminalEnvironmentWithoutModelAccess(
    baselineEnvironment,
    Object.keys(modelAccess.environment),
  );
  if (workload) {
    engineEnvironment.HOME = workload.home;
    engineEnvironment.USER = "vibe-workload";
    engineEnvironment.LOGNAME = "vibe-workload";
  }
  if (terminalWorkload) {
    terminalEnvironment.HOME = terminalWorkload.home;
    terminalEnvironment.USER = "vibe-terminal";
    terminalEnvironment.LOGNAME = "vibe-terminal";
  }

  const state: AgentState = { host: null, sessionId: null, startupError: null, hostClients: new Set(), terminals: new Map() };

  const ensureHost = () => {
    if (state.host && state.host.exitCode === null) return state.host;
    const host = spawn("/bin/sh", ["-c", "umask 002; exec \"$1\"", "vibe-engine", engineHost], {
      cwd: workspaceRoot,
      env: {
        ...engineEnvironment,
        VIBE_CLOUD_RUNTIME: "1",
        VIBE_CLOUD_PROVIDER: cloudProvider,
      },
      stdio: ["pipe", "pipe", "pipe"],
      ...(workload ? { uid: workload.uid, gid: workload.gid } : {}),
    });
    state.host = host;
    state.startupError = null;
    let stdout = "";
    host.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
          broadcast(state.hostClients, { channel: "fatal", message: "engine protocol frame exceeded limit" });
          host.kill("SIGKILL");
          break;
        }
        try {
          const payload = JSON.parse(line) as { type?: string; sessionId?: string; message?: string };
          if (payload.type === "fatal") state.startupError = payload.message ?? "engine bootstrap failed";
          if (payload.type === "ready" && typeof payload.sessionId === "string") {
            if (expectedSessionId && payload.sessionId !== expectedSessionId) {
              state.startupError = `cloud engine resumed ${payload.sessionId} instead of ${expectedSessionId}`;
              host.kill("SIGKILL");
            } else state.sessionId = payload.sessionId;
          }
          broadcast(state.hostClients, { channel: "engine", payload });
        }
        catch { broadcast(state.hostClients, { channel: "fatal", message: "engine emitted malformed JSON" }); }
      }
    });
    host.stderr.on("data", (chunk) => broadcast(state.hostClients, { channel: "diagnostic", stream: "stderr", data: chunk.toString("utf8").slice(-16_384) }));
    host.on("error", (error) => {
      if (state.host === host) {
        broadcast(state.hostClients, { channel: "fatal", message: `engine host could not start: ${error.message}` });
        state.host = null;
        state.sessionId = null;
      }
    });
    host.on("exit", (code, signal) => {
      if (state.host === host) {
        broadcast(state.hostClients, { channel: "fatal", message: `engine host exited (${signal ?? code ?? "unknown"})` });
        state.host = null;
        state.sessionId = null;
      }
    });
    return host;
  };

  const server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!safeEqual(supplied, accessToken)) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    if (request.url === "/health") {
      const sessionReady = !expectedSessionId || state.sessionId === expectedSessionId;
      const healthy = sessionReady && !state.startupError;
      response.statusCode = healthy ? 200 : 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: healthy,
        engine: state.host?.exitCode === null,
        sessionId: state.sessionId,
        modelAccess: {
          version: 1,
          validated: sessionReady && !state.startupError,
          environment: Object.keys(modelAccess.environment).sort(),
          requiredModels: modelAccess.profile.requiredModels,
        },
        ...(state.startupError ? { error: state.startupError } : {}),
        terminals: state.terminals.size,
      }));
      return;
    }
    response.writeHead(426).end("upgrade required");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  server.on("upgrade", (request, socket, head) => {
    const authorization = request.headers.authorization ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!safeEqual(supplied, accessToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  wss.on("connection", (socket) => {
    state.hostClients.add(socket);
    send(socket, { channel: "agent", type: "ready", protocol: 1, connectionId: randomUUID(), engineSessionId: state.sessionId });
    socket.on("message", async (raw) => {
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      if (bytes.byteLength > MAX_FRAME_BYTES) return socket.close(1009, "frame too large");
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(bytes.toString("utf8")); }
      catch { return send(socket, { channel: "error", error: "malformed JSON" }); }
      try {
        if (frame.channel === "agent" && frame.op === "detach-engine") {
          const host = state.host;
          state.host = null;
          state.sessionId = null;
          if (host) await terminateHost(host);
          send(socket, { channel: "agent", type: "detached" });
        } else if (frame.channel === "engine") {
          const host = ensureHost();
          const line = `${JSON.stringify(frame.payload)}\n`;
          if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("engine frame too large");
          host.stdin.write(line);
        } else if (frame.channel === "file") await handleFile(socket, frame, workspaceRoot, workload);
        else if (frame.channel === "terminal") await handleTerminal(socket, frame, state, workspaceRoot, terminalEnvironment, terminalWorkload);
        else if (frame.channel === "ping") send(socket, { channel: "pong", at: Date.now() });
        else throw new Error("unknown channel");
      } catch (error) {
        send(socket, { channel: "error", requestId: frame.requestId, error: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on("close", () => {
      state.hostClients.delete(socket);
      for (const terminal of state.terminals.values()) terminal.subscribers.delete(socket);
    });
  });
  server.listen(port, "0.0.0.0", () => {
    if (!expectedSessionId) return;
    const host = ensureHost();
    host.stdin.write(`${JSON.stringify({
      op: "bootstrap",
      cwd: workspaceRoot,
      resume: expectedSessionId,
      executionTarget: { kind: "cloud", provider: cloudProvider },
      ...(modelAccess.profile.requiredModels.length ? { requiredModels: modelAccess.profile.requiredModels } : {}),
      runtimeProfile: {
        schemaVersion: 1,
        theme: modelAccess.profile.theme,
        ...(modelAccess.profile.accentColor ? { accentColor: modelAccess.profile.accentColor } : {}),
        details: modelAccess.profile.details,
      },
    })}\n`);
  });
  return server;
}

async function handleFile(socket: ServerSocket, frame: Record<string, unknown>, root: string, workload: WorkloadIdentity | null): Promise<void> {
  if (typeof frame.path !== "string") throw new Error("file path required");
  const path = await resolveCloudPath(root, frame.path);
  if (frame.op === "write") {
    if (typeof frame.contentBase64 !== "string") throw new Error("file content required");
    const data = Buffer.from(frame.contentBase64, "base64");
    if (data.byteLength > MAX_FILE_BYTES) throw new Error("file exceeds 64 MiB");
    await mkdirForWorkload(root, dirname(path), workload);
    const requestedMode = typeof frame.mode === "number" ? frame.mode & 0o777 : 0o600;
    const sharedMode = sharedProjectFileMode(requestedMode);
    await writeFile(path, data, { mode: sharedMode });
    await chmod(path, sharedMode);
    if (workload) await chown(path, workload.uid, workload.gid);
    send(socket, { channel: "file", requestId: frame.requestId, ok: true });
  } else if (frame.op === "read") {
    const data = await readFile(path);
    if (data.byteLength > MAX_FILE_BYTES) throw new Error("file exceeds 64 MiB");
    send(socket, { channel: "file", requestId: frame.requestId, ok: true, contentBase64: data.toString("base64") });
  } else if (frame.op === "delete") {
    await rm(path, { recursive: true, force: true });
    send(socket, { channel: "file", requestId: frame.requestId, ok: true });
  } else throw new Error("unknown file operation");
}

async function handleTerminal(
  socket: ServerSocket,
  frame: Record<string, unknown>,
  state: AgentState,
  root: string,
  childEnvironment: Record<string, string>,
  workload: WorkloadIdentity | null,
): Promise<void> {
  if (frame.op === "create") {
    const id = typeof frame.id === "string" ? frame.id : randomUUID();
    if (state.terminals.has(id)) throw new Error("terminal already exists");
    const cwd = typeof frame.cwd === "string" ? await resolveCloudPath(root, frame.cwd) : root;
    const process = pty.spawn("/bin/bash", ["-lc", "umask 002; exec /bin/bash -l"], {
      cwd,
      cols: boundedInt(frame.cols, 80, 20, 400),
      rows: boundedInt(frame.rows, 24, 5, 200),
      env: { ...childEnvironment, TERM: "xterm-256color" },
      ...(workload ? { uid: workload.uid, gid: workload.gid } : {}),
    });
    const terminal: TerminalSession = { id, process, replay: "", subscribers: new Set([socket]) };
    state.terminals.set(id, terminal);
    process.onData((data) => {
      terminal.replay = (terminal.replay + data).slice(-TERMINAL_REPLAY_BYTES);
      broadcast(terminal.subscribers, { channel: "terminal", type: "data", id, data });
    });
    process.onExit(({ exitCode, signal }) => {
      broadcast(terminal.subscribers, { channel: "terminal", type: "exit", id, exitCode, signal });
      state.terminals.delete(id);
    });
    send(socket, { channel: "terminal", type: "created", id, pid: process.pid });
    return;
  }
  if (typeof frame.id !== "string") throw new Error("terminal id required");
  const terminal = state.terminals.get(frame.id);
  if (!terminal) throw new Error("terminal not found");
  if (frame.op === "attach") {
    terminal.subscribers.add(socket);
    send(socket, { channel: "terminal", type: "replay", id: terminal.id, data: terminal.replay });
  } else if (frame.op === "write") {
    if (typeof frame.data !== "string" || Buffer.byteLength(frame.data) > 64 * 1024) throw new Error("invalid terminal input");
    terminal.process.write(frame.data);
  } else if (frame.op === "resize") {
    terminal.process.resize(boundedInt(frame.cols, 80, 20, 400), boundedInt(frame.rows, 24, 5, 200));
  } else if (frame.op === "kill") terminal.process.kill();
  else if (frame.op === "detach") terminal.subscribers.delete(socket);
  else throw new Error("unknown terminal operation");
}

export async function resolveCloudPath(root: string, value: string): Promise<string> {
  const portable = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!portable || portable === "." || portable.includes("\0") || portable === ".." || portable.startsWith("../")) throw new Error("unsafe path");
  const path = resolve(root, portable);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("path escaped workspace");

  // Never follow a repository-controlled symlink while serving file RPCs. A
  // malicious workspace could otherwise point an innocent-looking child path
  // outside the transfer root after the lexical containment check above.
  const components = portable.split("/").filter(Boolean);
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink paths are not available through file RPC");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return path;
}

export function sharedProjectFileMode(requestedMode: number): number {
  const mode = requestedMode & 0o777;
  return mode | ((mode & 0o700) >> 3);
}

function safeEqual(value: string, expected: string): boolean {
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function environmentWithoutControlSecrets(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(([key, value]) => key !== "VIBE_CLOUD_ACCESS_TOKEN" && key !== "VIBE_CLOUD_ACCESS_TOKEN_FILE" && key !== "VIBE_CLOUD_MODEL_ACCESS_FILE" && typeof value === "string"),
  ) as Record<string, string>;
}

function workloadIdentity(options: AgentOptions): WorkloadIdentity | null {
  const uid = options.workloadUid ?? Number(process.env.VIBE_CLOUD_WORKLOAD_UID);
  const gid = options.workloadGid ?? Number(process.env.VIBE_CLOUD_WORKLOAD_GID);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) return null;
  return { uid, gid, home: process.env.VIBE_CLOUD_WORKLOAD_HOME || "/home/vibe-workload" };
}

function terminalIdentity(options: AgentOptions): WorkloadIdentity | null {
  const uid = options.terminalUid ?? Number(process.env.VIBE_CLOUD_TERMINAL_UID);
  const gid = options.terminalGid ?? Number(process.env.VIBE_CLOUD_TERMINAL_GID);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) return null;
  return { uid, gid, home: process.env.VIBE_CLOUD_TERMINAL_HOME || "/home/vibe-terminal" };
}

async function mkdirForWorkload(root: string, destination: string, workload: WorkloadIdentity | null): Promise<void> {
  await mkdir(destination, { recursive: true });
  if (!workload) return;
  const rel = relative(root, destination);
  if (!rel || rel === ".") return;
  let current = root;
  for (const component of rel.split(sep)) {
    current = resolve(current, component);
    await chown(current, workload.uid, workload.gid);
    await chmod(current, 0o2770);
  }
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

async function terminateHost(host: ChildProcessWithoutNullStreams): Promise<void> {
  if (host.exitCode !== null || host.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const hardTimeout = setTimeout(() => reject(new Error("engine host did not exit after forced detach")), 5_000);
    const forceTimeout = setTimeout(() => {
      host.kill("SIGKILL");
    }, 2_000);
    host.once("exit", () => {
      clearTimeout(forceTimeout);
      clearTimeout(hardTimeout);
      resolve();
    });
    if (!host.kill("SIGTERM")) {
      clearTimeout(forceTimeout);
      clearTimeout(hardTimeout);
      reject(new Error("engine host could not be detached"));
    }
  });
}

function send(socket: ServerSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function broadcast(sockets: Iterable<ServerSocket>, value: unknown): void {
  const data = JSON.stringify(value);
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(data);
}
