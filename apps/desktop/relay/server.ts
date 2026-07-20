// Vibe Codr remote-control relay — a desktop-side WebSocket server that exposes
// the local engine host's NDJSON protocol to the mobile app. It reuses the exact
// same EngineBridge + host-resolver the Electron main process uses, so the wire
// contract and host freshness checks are identical (no second host binary, no
// drift). The phone is a remote renderer; this relay is its engine gateway.
//
//   bun run relay/server.ts [--port 7788] [--cwd <path>]
//
// Prints a pairing token + LAN URL the mobile Connect screen consumes.
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir, networkInterfaces } from "node:os";
import { resolve as resolvePath } from "node:path";
import qrcode from "qrcode-terminal";
import { resolveHostLaunch, enrichedEnv } from "../src/main/host-resolver.js";
import type { UIEvent } from "@vibe/protocol";
import type { EngineStartOptions } from "../src/main/engine-bridge.js";
import { EngineTransportController } from "../src/main/engine-transport-controller.js";
import { cloudFailureDetails, CloudManager } from "../src/main/cloud/manager.js";
import type { ProtectedStringStorage } from "../src/main/cloud/credential-store.js";
import { TerminalManager } from "../src/main/terminal-manager.js";
import { projectCwdAllowlist, isAllowedCwd } from "../src/shared/cwd-allowlist.js";
import { isRelayInbound, type CloudRelayResult, type RelayInbound, type RelayOutbound } from "./protocol.js";
import { persistMobileUpload } from "./mobile-upload.js";
import type { ConfigScope, ConfigWriteRequest, MemoryWriteRequest } from "../src/shared/config-schema.js";
import { listProjectFiles, rankPaths } from "../src/shared/file-fuzzy.js";
import { readdirSync, readFileSync, existsSync, lstatSync, realpathSync } from "node:fs";
import {
  configPathForScope, readConfigFile, writeConfigFileValidated,
  memoryPathForScope, readMemoryFile, writeMemoryFile,
} from "../src/shared/config-io.js";
import { validateConfig } from "../src/shared/config-validate.js";
import { resolveWritablePathInsideRoot } from "../src/shared/path-safe.js";
import {
  checkoutBranch, commit, createBranch, deleteBranch, fetchRemotes, getFullStatus,
  isGitRepo, mergeBranch, pullBranch, pushBranch, stageAll, stageFiles, unstageAll, unstageFiles,
} from "../src/shared/git-ops.js";
import { parseGhPrList, validateGhPrCreateRequest, type GitResult } from "../src/shared/git-types.js";
import { safeExternalUrl } from "../src/shared/external-url.js";
import { createServer as createHttpsServer } from "node:https";
import {
  HOST_PROTOCOL_VERSION,
  decodeInbound,
  type HostInbound,
  type HostOutbound,
  type HostRpcParams,
  type RpcMethod,
} from "@vibe/protocol";
import { isPrivateNetworkAddress, privateLanIPv4 } from "../src/shared/private-network.js";

const PROJECT_INDEX_RPCS = new Set<RpcMethod>(["listProjects", "searchSessions", "renameProject", "archiveProject", "deleteProject", "renameSession", "deleteSession", "archiveSession", "forkSession"]);
const PROJECT_INDEX_MUTATIONS = new Set<RpcMethod>(["renameProject", "archiveProject", "deleteProject", "renameSession", "deleteSession", "archiveSession", "forkSession"]);
const SESSION_HISTORY_MUTATIONS = new Set<RpcMethod>(["renameSession", "deleteSession", "archiveSession", "forkSession"]);
const PROJECT_RECOVERY_MUTATIONS = new Set<RpcMethod>(["archiveProject", "deleteProject"]);
const SESSION_RUNTIME_MUTATIONS = new Set<RpcMethod>(["renameSession", "deleteSession", "archiveSession"]);
const PROJECT_RUNTIME_MUTATIONS = new Set<RpcMethod>(["archiveProject", "deleteProject"]);
const PROVIDER_AUTH_RPCS = new Set<RpcMethod>(["providerAuthStatus", "beginProviderAuth", "cancelProviderAuth", "logoutProviderAuth"]);
const CONTROLLER_HEARTBEAT_MS = 30_000;

const ELECTRON_ROOT = process.env.VIBE_ELECTRON_ROOT
  ? resolvePath(process.env.VIBE_ELECTRON_ROOT)
  : resolvePath(import.meta.dirname, "..");
const ADJACENT_ENGINE_ROOT = resolvePath(ELECTRON_ROOT, "..", "source");
if (!process.env.VIBE_CODR_ROOT && existsSync(resolvePath(ADJACENT_ENGINE_ROOT, "package.json"))) {
  process.env.VIBE_CODR_ROOT = ADJACENT_ENGINE_ROOT;
}
// Host resolution looks for the packaged host under <appPath>/resources; the
// relay ships in relay/ so chdir to the electron root before resolving.
process.chdir(ELECTRON_ROOT);
const PORT = Number(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? process.env.VIBE_RELAY_PORT ?? 7788);
const HOST = process.argv.find((a) => a.startsWith("--host="))?.split("=")[1] ?? privateLanIPv4(networkInterfaces()) ?? "127.0.0.1";
const CWD = process.argv.find((a) => a.startsWith("--cwd="))?.split("=")[1] ?? ELECTRON_ROOT;
const TOKEN = process.env.VIBE_RELAY_TOKEN ?? randomUUID();
const MANAGED = process.env.VIBE_RELAY_MANAGED === "1";
const INITIAL_SESSION_ID = process.env.VIBE_RELAY_SESSION_ID ?? "";
const TLS_CERT = process.argv.find((a) => a.startsWith("--tls-cert="))?.split("=")[1];
const TLS_KEY = process.argv.find((a) => a.startsWith("--tls-key="))?.split("=")[1];
// The relay is an intentionally-launched desktop tool; seed the cwd allowlist so
// the contextual terminal may open in the active project (and home, always allowed).
projectCwdAllowlist.add(CWD);

function runGh(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, { cwd, env: enrichedEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false;
    const maxBytes = 1024 * 1024;
    const finish = (result: { ok: boolean; stdout: string; stderr: string }) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const append = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(0, maxBytes);
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish({ ok: false, stdout, stderr: stderr || "gh command timed out" }); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", () => finish({ ok: false, stdout, stderr: "gh CLI not found" }));
    child.on("close", (code) => finish({ ok: code === 0, stdout, stderr }));
  });
}

function send(ws: WebSocket, msg: HostOutbound): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(`${JSON.stringify(msg)}\n`);
}

function sendRelay(ws: WebSocket, msg: RelayOutbound): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(`${JSON.stringify(msg)}\n`);
}

async function main(): Promise<void> {
  try {
    resolveHostLaunch();
  } catch (error) {
    console.error("✗ Could not resolve a vibecodr-engine-host.");
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    console.error("  Build the host: cd ~/Code/vibe-codr && bun run build:macos-bridge");
    process.exit(1);
  }

  const bridge = new EngineTransportController();
  const cloudUserData = process.env.VIBE_RELAY_USER_DATA ?? resolvePath(homedir(), ".vibe", "electron");
  const electron = await import("electron").catch(() => null);
  if (electron?.app) await electron.app.whenReady();
  const storageWaiters = new Map<string, {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  const requestProtectedStorage = (op: "encrypt" | "decrypt", value: string): Promise<string> => new Promise((resolve, reject) => {
    if (!process.send) { reject(new Error("Desktop protected-storage bridge is unavailable")); return; }
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      storageWaiters.delete(requestId);
      reject(new Error("Desktop protected-storage request timed out"));
    }, 15_000);
    storageWaiters.set(requestId, { resolve, reject, timer });
    process.send({ type: "protected-storage", requestId, op, value }, (error) => {
      if (!error) return;
      const waiter = storageWaiters.get(requestId);
      if (!waiter) return;
      storageWaiters.delete(requestId);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
  });
  const parentProtectedStorage: ProtectedStringStorage | undefined = MANAGED && process.env.VIBE_RELAY_PROTECTED_STORAGE === "1"
    ? {
        isEncryptionAvailable: () => true,
        encryptString: async (value) => Buffer.from(await requestProtectedStorage("encrypt", value), "base64"),
        decryptString: (value) => requestProtectedStorage("decrypt", value.toString("base64")),
      }
    : undefined;
  const localProtectedStorage = electron?.safeStorage?.isEncryptionAvailable?.() ? electron.safeStorage : undefined;
  const cloudManager = new CloudManager(bridge, cloudUserData, localProtectedStorage ?? parentProtectedStorage);
  cloudManager.runtimeLocation = electron?.app
    ? { isPackaged: electron.app.isPackaged, appPath: electron.app.getAppPath(), resourcesPath: process.resourcesPath }
    : { isPackaged: false, appPath: ELECTRON_ROOT, resourcesPath: ELECTRON_ROOT };

  const httpsServer = TLS_CERT && TLS_KEY
    ? createHttpsServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) })
    : null;
  const wss = httpsServer
    ? new WebSocketServer({ server: httpsServer, maxPayload: 32 * 1024 * 1024 })
    : new WebSocketServer({ host: HOST, port: PORT, maxPayload: 32 * 1024 * 1024 });
  httpsServer?.listen(PORT, HOST);
  let controller: WebSocket | null = null;
  let controllerAlive = false;
  let activeSessionId = "";
  let activeProtocolInfo: Omit<Extract<HostOutbound, { type: "ready" }>, "type" | "sessionId"> | null = null;
  let activeCwd = "";
  let handoffSessionId = INITIAL_SESSION_ID;
  let mobileAuthorized = !MANAGED || process.env.VIBE_RELAY_MOBILE_AUTHORIZED === "1";
  let releasingOwnership = false;
  const controllerHeartbeat = setInterval(() => {
    const socket = controller;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (!controllerAlive) {
      socket.terminate();
      if (controller === socket) controller = null;
      return;
    }
    controllerAlive = false;
    socket.ping();
  }, CONTROLLER_HEARTBEAT_MS);

  // Persistent contextual terminal (shell feature, not engine). PTY + bounded
  // replay buffer survive across mobile reconnects, mirroring the desktop
  // terminal-manager lifecycle. Forwards data/exit to the connected controller.
  const terminals = new TerminalManager((event) => {
    if (controller) sendRelay(controller, { relay: "term-event", event });
  });

  // Keep the engine alive across transient phone network/background drops.
  // An explicit shutdown remains the ownership-release point back to desktop.
  bridge.onReady = (sessionId, info) => {
    activeSessionId = sessionId;
    activeProtocolInfo = info ? {
      protocolVersion: HOST_PROTOCOL_VERSION,
      engineRevision: info.engineRevision,
      capabilities: ["event-replay"],
      hostInstanceId: info.hostInstanceId,
    } : null;
    if (controller && activeProtocolInfo) send(controller, { type: "ready", sessionId, ...activeProtocolInfo });
  };
  bridge.onEvent = (event, frame) => {
    cloudManager.observeEngineEvent(event);
    // Every sequenced host event must cross the relay. Filtering one event here
    // creates an artificial cursor gap and forces the phone into replay.
    if (controller && frame) send(controller, { type: "event", event: event as UIEvent, ...frame });
  };
  bridge.onResync = (snapshot) => {
    activeSessionId = snapshot.sessionId;
    if (controller && activeProtocolInfo) {
      send(controller, { type: "ready", sessionId: snapshot.sessionId, ...activeProtocolInfo });
    }
  };
  bridge.onFatal = (message) => {
    if (controller) send(controller, { type: "fatal", message });
  };
  cloudManager.onStatus = (event) => {
    if (controller) sendRelay(controller, { relay: "cloud-status", event });
  };

  wss.on("listening", () => {
    const scheme = TLS_CERT && TLS_KEY ? "wss" : "ws";
    const url = `${scheme}://${HOST}:${PORT}`;
    console.log("vibecodr relay");
    console.log(`  token : ${TOKEN}`);
    console.log(`  url   : ${url}`);
    console.log(`  cwd   : ${CWD}`);
    const deep = `vibecodr://connect?url=${encodeURIComponent(url)}&token=${encodeURIComponent(TOKEN)}&cwd=${encodeURIComponent(CWD)}${INITIAL_SESSION_ID ? `&session=${encodeURIComponent(INITIAL_SESSION_ID)}` : ""}`;
    console.log("  scan to pair (Vibe Codr mobile):");
    qrcode.generate(deep, { small: true }, (code: string) => console.log(code));
    console.log("  waiting for a mobile connection…");
  });

  wss.on("connection", (ws, req) => {
    if (!httpsServer && !isPrivateNetworkAddress(req.socket.remoteAddress ?? "")) {
      ws.close(4004, "plaintext relay is private-network only; use WSS");
      return;
    }
    const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
    if (token !== TOKEN) {
      ws.close(4001, "unauthorized");
      return;
    }
    if (!mobileAuthorized) {
      ws.close(4003, "Desktop has control. Choose Continue on Phone on your Mac first.");
      return;
    }
    if (controller && controller.readyState === WebSocket.OPEN) {
      ws.close(4002, "a controller is already connected");
      return;
    }
    controller = ws;
    controllerAlive = true;
    console.log("✓ mobile controller connected");
    ws.on("pong", () => {
      if (controller === ws) controllerAlive = true;
    });

    ws.on("message", (data) => {
      if (controller === ws) controllerAlive = true;
      for (const line of String(data).split("\n")) {
        if (!line.trim()) continue;
        let parsed: unknown = null;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (isRelayInbound(parsed)) {
          void handleRelay(ws, parsed);
          continue;
        }
        const msg = decodeInbound(line) as HostInbound | null;
        if (!msg) continue;
        void handleInbound(ws, msg).catch((error) => {
          send(ws, { type: "fatal", message: error instanceof Error ? error.message : String(error) });
        });
      }
    });

    ws.on("close", () => {
      console.log("✗ mobile controller disconnected");
      if (controller === ws) {
        controller = null;
        controllerAlive = false;
      }
    });
    ws.on("error", () => undefined);
  });

  async function releaseToDesktop(): Promise<void> {
    if (releasingOwnership) return;
    releasingOwnership = true;
    const sessionId = activeSessionId;
    const cwd = activeCwd || CWD;
    try {
      await bridge.stopAllOwnedRuntimes();
    } catch (error) {
      if (controller) {
        send(controller, {
          type: "fatal",
          message: `Could not return control to desktop: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      releasingOwnership = false;
      return;
    }
    activeSessionId = "";
    activeCwd = "";
    mobileAuthorized = false;
    if (controller?.readyState === WebSocket.OPEN) controller.close(1000, "desktop-control");
    process.send?.({ type: "mobile-released", sessionId, cwd });
    releasingOwnership = false;
  }

  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const value = message as {
      type?: string;
      cwd?: string;
      sessionId?: string;
      requestId?: string;
      ok?: boolean;
      value?: string;
      error?: string;
    };
    if (value.type === "protected-storage-result" && typeof value.requestId === "string") {
      const waiter = storageWaiters.get(value.requestId);
      if (!waiter) return;
      storageWaiters.delete(value.requestId);
      clearTimeout(waiter.timer);
      if (value.ok === true && typeof value.value === "string") waiter.resolve(value.value);
      else waiter.reject(new Error(value.error || "Desktop protected-storage request failed"));
      return;
    }
    if (!MANAGED) return;
    if (value.type === "desktop-released") {
      bridge.restoreLocalRuntimeOwnership();
      if (typeof value.cwd === "string" && value.cwd) {
        projectCwdAllowlist.add(value.cwd);
        activeCwd = value.cwd;
      }
      handoffSessionId = typeof value.sessionId === "string" ? value.sessionId : "";
      mobileAuthorized = true;
      return;
    }
    if (value.type === "return-to-desktop") void releaseToDesktop();
  });

  function scopedConfigPath(scope: ConfigScope, cwd?: string): string {
    if (scope === "global") return configPathForScope(scope);
    if (!cwd) throw new Error("Project scope requires a cwd");
    const located = resolveWritablePathInsideRoot(cwd, ".vibe/config.json", { existsSync, lstatSync, realpathSync });
    if (!located.ok) throw new Error(located.error);
    return located.target;
  }
  function scopedMemoryPath(scope: ConfigScope, cwd?: string): string {
    if (scope === "global") return memoryPathForScope(scope);
    if (!cwd) throw new Error("Project scope requires a cwd");
    const located = resolveWritablePathInsideRoot(cwd, "VIBE.md", { existsSync, lstatSync, realpathSync });
    if (!located.ok) throw new Error(located.error);
    return located.target;
  }
  async function readConfig(scope: ConfigScope, cwd?: string): Promise<{ ok: true; config: Record<string, unknown>; path: string; raw: string } | { ok: false; error: string }> {
    if (scope === "project" && (!cwd || !isAllowedCwd(cwd))) return { ok: false, error: "cwd is not an opened project root" };
    try {
      const path = scopedConfigPath(scope, cwd);
      const read = await readConfigFile(path);
      if (!read) return { ok: true, config: {}, path, raw: "" };
      return { ok: true, config: read.config as Record<string, unknown>, path, raw: read.raw };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  }
  async function writeConfig(request: ConfigWriteRequest): Promise<{ ok: true; config: Record<string, unknown> } | { ok: false; error: string }> {
    if (request.scope === "project" && (!request.cwd || !isAllowedCwd(request.cwd))) return { ok: false, error: "cwd is not an opened project root" };
    try {
      const path = scopedConfigPath(request.scope, request.cwd);
      const result = await writeConfigFileValidated(path, request.patch, validateConfig);
      return result.ok ? { ok: true, config: result.config as Record<string, unknown> } : { ok: false, error: result.error };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  }
  async function readMemory(scope: ConfigScope, cwd?: string): Promise<{ ok: true; path: string; content: string; exists: boolean } | { ok: false; error: string }> {
    if (scope === "project" && (!cwd || !isAllowedCwd(cwd))) return { ok: false, error: "cwd is not an opened project root" };
    try {
      const path = scopedMemoryPath(scope, cwd);
      const read = await readMemoryFile(path);
      return { ok: true, path, content: read.content, exists: read.exists };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  }
  async function writeMemory(request: MemoryWriteRequest): Promise<{ ok: true } | { ok: false; error: string }> {
    if (request.scope === "project" && (!request.cwd || !isAllowedCwd(request.cwd))) return { ok: false, error: "cwd is not an opened project root" };
    try {
      const path = scopedMemoryPath(request.scope, request.cwd);
      await writeMemoryFile(path, request.content);
      return { ok: true };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  }

  async function handleRelay(ws: WebSocket, msg: RelayInbound): Promise<void> {
    switch (msg.relay) {
      case "term-open": {
        const result = terminals.open({ cwd: msg.cwd, cols: msg.cols, rows: msg.rows });
        sendRelay(ws, { relay: "term-opened", requestId: msg.requestId, result });
        return;
      }
      case "term-input": {
        const result = terminals.write(msg.id, msg.data);
        sendRelay(ws, { relay: "term-command", requestId: msg.requestId, result });
        return;
      }
      case "term-resize": {
        const result = terminals.resize(msg.id, msg.cols, msg.rows);
        sendRelay(ws, { relay: "term-command", requestId: msg.requestId, result });
        return;
      }
      case "term-close": {
        // Detach only — the PTY + replay buffer persist (desktop parity: close
        // detaches the renderer, the main-owned PTY survives until shutdown).
        sendRelay(ws, { relay: "term-closed", requestId: msg.requestId, id: msg.id });
        return;
      }
      case "list-files": {
        if (!isAllowedCwd(msg.cwd)) {
          sendRelay(ws, { relay: "files", requestId: msg.requestId, paths: [] });
          return;
        }
        const readdir = (dir: string) => readdirSync(dir, { withFileTypes: true })
          .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
        const all = listProjectFiles(msg.cwd, { readdir });
        const paths = rankPaths(all, msg.query, msg.limit || 40);
        sendRelay(ws, { relay: "files", requestId: msg.requestId, paths });
        return;
      }
      case "upload-file": {
        if (!isAllowedCwd(msg.cwd)) {
          sendRelay(ws, { relay: "upload-result", requestId: msg.requestId, result: { ok: false, error: "cwd is not an opened project root" } });
          return;
        }
        const result = await persistMobileUpload(msg.cwd, {
          name: msg.name,
          ...(msg.mimeType ? { mimeType: msg.mimeType } : {}),
          dataBase64: msg.dataBase64,
        });
        sendRelay(ws, { relay: "upload-result", requestId: msg.requestId, result });
        return;
      }
      case "config-read": {
        const result = await readConfig(msg.scope, msg.cwd);
        sendRelay(ws, { relay: "config-read-result", requestId: msg.requestId, result });
        return;
      }
      case "config-write": {
        const result = await writeConfig(msg.request);
        sendRelay(ws, { relay: "config-write-result", requestId: msg.requestId, result });
        return;
      }
      case "memory-read": {
        const result = await readMemory(msg.scope, msg.cwd);
        sendRelay(ws, { relay: "memory-read-result", requestId: msg.requestId, result });
        return;
      }
      case "memory-write": {
        const result = await writeMemory(msg.request);
        sendRelay(ws, { relay: "memory-write-result", requestId: msg.requestId, result });
        return;
      }
      case "git": {
        const request = msg.request;
        const cwd = "cwd" in request ? request.cwd : request.request.cwd;
        if (!isAllowedCwd(cwd)) {
          sendRelay(ws, { relay: "git-result", requestId: msg.requestId, result: { ok: false, error: "cwd is not an opened project root" } });
          return;
        }
        try {
          if (request.action === "status") {
            const status = await isGitRepo(cwd) ? await getFullStatus(cwd) : null;
            sendRelay(ws, { relay: "git-result", requestId: msg.requestId, result: { ok: true, status } });
            return;
          }
          if (request.action === "ghAvailable") {
            const available = (await runGh(cwd, ["--version"])).ok;
            sendRelay(ws, { relay: "git-result", requestId: msg.requestId, result: { ok: true, available } });
            return;
          }
          if (request.action === "prList") {
            const listed = await runGh(cwd, ["pr", "list", "--json", "number,title,state,headRefName,url", "--limit", "20"]);
            if (!listed.ok) {
              sendRelay(ws, { relay: "git-result", requestId: msg.requestId, result: { ok: false, error: listed.stderr || "gh command failed" } });
              return;
            }
            const prs = parseGhPrList(JSON.parse(listed.stdout) as unknown);
            sendRelay(ws, { relay: "git-result", requestId: msg.requestId, result: prs ? { ok: true, prs } : { ok: false, error: "gh returned an invalid pull-request list" } });
            return;
          }
          if (request.action === "prCreate") {
            if (!validateGhPrCreateRequest(request.request)) {
              sendRelay(ws, { relay: "git-result", requestId: msg.requestId, result: { ok: false, error: "Invalid pull-request details" } });
              return;
            }
            const args = ["pr", "create", "--title", request.request.title];
            if (request.request.body) args.push("--body", request.request.body);
            if (request.request.base) args.push("--base", request.request.base);
            if (request.request.head) args.push("--head", request.request.head);
            if (request.request.draft) args.push("--draft");
            const created = await runGh(cwd, args);
            if (!created.ok) {
              sendRelay(ws, { relay: "git-result", requestId: msg.requestId, result: { ok: false, error: created.stderr || "gh pr create failed" } });
              return;
            }
            const rawUrl = created.stdout.trim().split("\n")[0] || undefined;
            const url = rawUrl ? safeExternalUrl(rawUrl) : undefined;
            sendRelay(ws, { relay: "git-result", requestId: msg.requestId, result: rawUrl && !url ? { ok: false, error: "gh returned an invalid pull-request URL" } : { ok: true, ...(url ? { url } : {}), message: "Pull request created" } });
            return;
          }
          let result: GitResult;
          switch (request.action) {
            case "createBranch": result = await createBranch(cwd, request.request.name, request.request.from, request.request.checkout); break;
            case "checkout": result = await checkoutBranch(cwd, request.request.name, request.request.track); break;
            case "deleteBranch": result = await deleteBranch(cwd, request.request.name, request.request.force); break;
            case "stage": result = request.request.all || request.request.allIncludingUntracked
              ? await stageAll(cwd, request.request.allIncludingUntracked ?? false)
              : await stageFiles(cwd, request.request.paths ?? []); break;
            case "unstage": result = request.request.paths?.length
              ? await unstageFiles(cwd, request.request.paths)
              : await unstageAll(cwd); break;
            case "commit": result = await commit(cwd, request.request.message, {
              stageAll: request.request.stageAll,
              stageAllIncludingUntracked: request.request.stageAllIncludingUntracked,
              amend: request.request.amend,
            }); break;
            case "merge": result = await mergeBranch(cwd, request.request.branch, request.request.noFastForward); break;
            case "push": result = await pushBranch(cwd, request.request); break;
            case "pull": result = await pullBranch(cwd, request.request); break;
            case "fetch": result = await fetchRemotes(cwd, request.request.remote); break;
          }
          sendRelay(ws, { relay: "git-result", requestId: msg.requestId, result: result.ok
            ? { ok: true, ...(result.message ? { message: result.message } : {}) }
            : { ok: false, error: result.stderr || "Git operation failed" } });
        } catch (error) {
          sendRelay(ws, { relay: "git-result", requestId: msg.requestId, result: { ok: false, error: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }
      case "cloud": {
        const request = msg.request;
        const reply = (result: CloudRelayResult) => sendRelay(ws, { relay: "cloud-result", requestId: msg.requestId, result });
        if (request.action === "handoff" && !isAllowedCwd(request.request.cwd)) {
          reply({ ok: false, error: "Cloud handoff is limited to the active authorized project" });
          return;
        }
        try {
          switch (request.action) {
            case "settings": reply({ ok: true, value: await cloudManager.settings() }); return;
            case "updateSettings": reply({ ok: true, value: await cloudManager.updateSettings(request.patch) }); return;
            case "connect": reply({ ok: true, value: await cloudManager.connect(request.provider, request.credentials as never) }); return;
            case "disconnect": reply({ ok: true, value: await cloudManager.disconnect(request.provider) }); return;
            case "test": reply({ ok: true, value: await cloudManager.test(request.provider) }); return;
            case "listSessions": reply({ ok: true, value: await cloudManager.listSessions() }); return;
            case "saveBinding": reply({ ok: true, value: await cloudManager.saveCredentialBinding(request.input) }); return;
            case "removeBinding": reply({ ok: true, value: await cloudManager.removeCredentialBinding(request.id) }); return;
            case "handoff": reply({ ok: true, value: await cloudManager.handoffToCloud(request.request) }); return;
            case "reconnect": reply({ ok: true, sessionId: await cloudManager.reconnect(request.sessionId) }); return;
            case "resumeLocal": {
              const value = await cloudManager.resumeLocally(request.sessionId, request.keepCloudCopy);
              projectCwdAllowlist.add(value.cwd);
              reply({ ok: true, value }); return;
            }
            case "deleteCopy": await cloudManager.deleteCloudCopy(request.sessionId); reply({ ok: true }); return;
            case "recoverLost": {
              const value = await cloudManager.recoverLostSession(request.sessionId);
              projectCwdAllowlist.add(value.cwd);
              reply({ ok: true, value }); return;
            }
          }
        } catch (error) {
          const details = cloudFailureDetails(error);
          reply({ ok: false, error: error instanceof Error ? error.message : String(error), ...(details ? { details } : {}) });
        }
        return;
      }
    }
  }

  async function handleInbound(ws: WebSocket, msg: HostInbound): Promise<void> {
    if (msg.op === "bootstrap") {
      projectCwdAllowlist.add(msg.cwd);
      if (
        bridge.isReady &&
        activeSessionId &&
        activeCwd === msg.cwd &&
        (msg.resume === activeSessionId || msg.continue === true)
      ) {
        if (activeProtocolInfo) send(ws, { type: "ready", sessionId: activeSessionId, ...activeProtocolInfo });
        return;
      }
      const opts: EngineStartOptions = {
        cwd: msg.cwd,
        ...(handoffSessionId || msg.resume ? { resume: handoffSessionId || msg.resume } : {}),
        ...(!handoffSessionId && msg.continue ? { continueLatest: true } : {}),
        ...(msg.model ? { model: msg.model } : {}),
        ...(msg.mode ? { mode: msg.mode } : {}),
      };
      activeCwd = msg.cwd;
      await bridge.start(opts);
      handoffSessionId = activeSessionId || handoffSessionId;
      // onReady (wired above) sends the ready frame; no duplicate send here.
      return;
    }
    if (msg.op === "send") {
      bridge.send(msg.command);
      return;
    }
    if (msg.op === "rpc") {
      try {
        const method = msg.method as RpcMethod;
        let params = msg.params as HostRpcParams | undefined;
        let historyMutation: { cwd: string; sessionId?: string } | null = null;
        if (method === "searchSessions" && params?.cwd !== undefined) {
          if (typeof params.cwd !== "string" || !isAllowedCwd(params.cwd)) {
            throw new Error("Transcript search is limited to opened projects");
          }
        }
        if (PROJECT_INDEX_MUTATIONS.has(method)) {
          const cwd = params?.cwd;
          if (typeof cwd !== "string" || !isAllowedCwd(cwd)) {
            throw new Error("Project history changes are limited to opened projects");
          }
          if (SESSION_HISTORY_MUTATIONS.has(method) || PROJECT_RECOVERY_MUTATIONS.has(method)) {
            const rawSessionId = SESSION_HISTORY_MUTATIONS.has(method) ? params?.id : undefined;
            const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : undefined;
            if (sessionId !== undefined) params = { ...params, id: sessionId } as HostRpcParams;
            historyMutation = { cwd, ...(sessionId !== undefined ? { sessionId } : {}) };
          }
          if (SESSION_RUNTIME_MUTATIONS.has(method)) {
            const id = params?.id;
            if (typeof id !== "string") throw new Error("A session ID is required");
            const retirement = await bridge.retireLocalSessionForMutation(cwd, id, method === "renameSession");
            if (!retirement.ok) {
              throw new Error(`This session is still ${retirement.state}. Finish or stop it before changing its saved history.`);
            }
          } else if (PROJECT_RUNTIME_MUTATIONS.has(method)) {
            const retirement = await bridge.retireLocalProjectForMutation(cwd);
            if (!retirement.ok) {
              throw new Error(retirement.state === "foreground"
                ? "Open another project before removing this project."
                : `A session in this project is still ${retirement.state}. Finish or stop it before removing the project.`);
            }
          }
        }
        const value = PROJECT_INDEX_RPCS.has(method)
          ? historyMutation
            ? await cloudManager.runHistoryMutation(
                historyMutation.cwd,
                historyMutation.sessionId,
                () => bridge.projectIndexRpc(method, params),
              )
            : await bridge.projectIndexRpc(method, params)
          : PROVIDER_AUTH_RPCS.has(method)
            ? await bridge.providerAuthRpc(method, params)
            : await bridge.rpc(method, params);
        send(ws, { type: "resp", id: msg.id, ok: true, value });
      } catch (error) {
        send(ws, { type: "resp", id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (msg.op === "shutdown") {
      if (MANAGED) {
        await releaseToDesktop();
      } else {
        await bridge.stopAllOwnedRuntimes();
        activeSessionId = "";
        activeCwd = "";
        ws.close(1000, "shutdown");
      }
      if (!MANAGED && process.env.VIBE_RELAY_EXIT_ON_RELEASE === "1") {
        try { terminals.dispose(); } catch { /* best-effort */ }
        wss.close(() => process.exit(0));
      }
    }
  }

  const shutdown = async () => {
    clearInterval(controllerHeartbeat);
    for (const waiter of storageWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Mobile relay is shutting down"));
    }
    storageWaiters.clear();
    try { terminals.dispose(); } catch { /* best-effort */ }
    try { await bridge.disposeForQuit(); } catch { /* best-effort */ }
    wss.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
