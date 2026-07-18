import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const root = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "vibecodr-packaged-relay-"));
const project = join(temporaryRoot, "project");
await cp(join(root, "test", "fixtures", "project"), project, { recursive: true });

const mac = process.platform === "darwin";
const appRoot = mac
  ? join(root, "release", process.arch === "arm64" ? "mac-arm64" : "mac", "Vibe Codr.app", "Contents")
  : join(root, "release", "win-unpacked");
const executable = mac ? join(appRoot, "MacOS", "Vibe Codr") : join(appRoot, "Vibe Codr.exe");
const resources = mac ? join(appRoot, "Resources") : join(appRoot, "resources");
const relayEntry = join(resources, "app.asar", "out", "main", "relay.js");
const port = await availablePort();
const token = `packaged-relay-${process.pid}`;

let child;
try {
  child = spawn(executable, [relayEntry, "--host=127.0.0.1", `--port=${port}`, `--cwd=${project}`], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      VIBE_CODR_ROOT: "",
      VIBE_ELECTRON_ROOT: resources,
      VIBE_RELAY_TOKEN: token,
      VIBE_RELAY_EXIT_ON_RELEASE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`Packaged relay did not start:\n${output}`)), 15_000);
    const append = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-32_000);
      if (!output.includes("waiting for a mobile connection")) return;
      clearTimeout(timer);
      resolveReady();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`Packaged relay exited before ready (${code ?? "unknown"}):\n${output}`));
    });
  });

  const sessionId = await exerciseRelay(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, project);
  const exit = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Packaged relay did not exit after ownership release")), 10_000)),
  ]);
  if (exit.code !== 0) throw new Error(`Packaged relay exited with ${exit.code ?? exit.signal ?? "unknown"}:\n${output}`);
  process.stdout.write(`packaged relay smoke ok: resumed ${sessionId} through bundled host and released cleanly\n`);
} finally {
  if (child?.exitCode == null) child.kill("SIGTERM");
  await rm(temporaryRoot, { recursive: true, force: true });
}

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not allocate relay smoke port"));
        return;
      }
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}

function exerciseRelay(url, cwd) {
  return new Promise((resolveSession, rejectSession) => {
    const socket = new WebSocket(url);
    let sessionId = "";
    const timer = setTimeout(() => {
      socket.terminate();
      rejectSession(new Error("Packaged relay session timed out"));
    }, 20_000);
    const fail = (error) => {
      clearTimeout(timer);
      rejectSession(error instanceof Error ? error : new Error(String(error)));
    };
    socket.once("open", () => socket.send(`${JSON.stringify({ op: "bootstrap", cwd })}\n`));
    socket.on("message", (raw) => {
      for (const line of raw.toString().split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.type === "fatal") { fail(new Error(message.message)); return; }
        if (message.type !== "ready" || typeof message.sessionId !== "string") continue;
        sessionId = message.sessionId;
        socket.send(`${JSON.stringify({ op: "shutdown" })}\n`);
      }
    });
    socket.once("error", fail);
    socket.once("close", () => {
      clearTimeout(timer);
      if (sessionId) resolveSession(sessionId);
      else rejectSession(new Error("Packaged relay closed before engine ready"));
    });
  });
}
