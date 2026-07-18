import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { chmod, open as fsOpen, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { MessageBoxSyncOptions } from "electron";
import { app, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, session, shell } from "electron";
import { readTextFileCapped } from "../shared/capped-read";
import type { EngineCommand } from "../shared/commands";
import { isAllowedCwd, isAllowedProjectRoot, isAllowedRevealPath, projectCwdAllowlist } from "../shared/cwd-allowlist";
import { composeInEditor, EDITOR_DRAFT_MAX_BYTES } from "../shared/editor-compose";
import { safeExternalUrl } from "../shared/external-url";
import { listProjectFiles, rankPaths } from "../shared/file-fuzzy";
import type { MenuAction } from "../shared/menu-actions";
import { resolvePathInsideRoot, resolveWritablePathInsideRoot } from "../shared/path-safe";
import { chatsCwdFromHome } from "../shared/project-index";
import { isRendererRpcMethod } from "../shared/renderer-rpc";
import type { ProjectSummary } from "../shared/protocol";
import { decodeInbound, type HostInbound, type RpcMethod } from "../shared/protocol";
import { isProjectSummaryArray } from "../shared/runtime-guards";
import { TtlLruCache } from "../shared/ttl-lru-cache";
import { type AppUpdaterController, createAppUpdater } from "./app-updater";
import { registerConfigIpc } from "./config-ipc";
import { EngineTransportController } from "./engine-transport-controller";
import { cloudFailureDetails, CloudManager } from "./cloud/manager";
import { registerGitIpc } from "./git-ipc";
import { enrichedEnv } from "./host-resolver";
import { assertTrustedIpc, assertTrustedSender, getMainWindow, setMainWindow } from "./ipc-security";
import { TerminalManager } from "./terminal-manager";
import { MobileRelayController } from "./mobile-relay-controller";

let mainWindow: BrowserWindow | null = null;
let settingsDirty = false;
let appUpdater: AppUpdaterController | null = null;
const bridge = new EngineTransportController();
const cloudManager = new CloudManager(bridge, app.getPath("userData"), safeStorage);
cloudManager.runtimeLocation = { isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath };
let lastDesktopCwd = "";
let lastDesktopSessionId = "";

const mobileRelay = new MobileRelayController({
  getParent: () => mainWindow,
  releaseDesktop: async () => {
    if (cloudManager.ownershipTransitioning) throw new Error("Wait for the current cloud handoff to finish first.");
    if (bridge.isRemote) throw new Error("Return this session to Local before moving control to your phone.");
    if (bridge.isRunning) await bridge.stop();
  },
  resumeDesktop: (sessionId, cwd) => {
    if (sessionId) lastDesktopSessionId = sessionId;
    if (cwd) lastDesktopCwd = cwd;
    setTimeout(() => sendMenuAction("continueLatest"), 150);
  },
});

async function startMobileRemoteControl(): Promise<void> {
  if (!lastDesktopCwd) {
    const options: import("electron").MessageBoxOptions = {
      type: "info",
      title: "Mobile Remote Control",
      message: "Open a project or chat first.",
      detail: "Vibe needs an active workspace before it can continue the same session on your phone.",
      buttons: ["OK"],
    };
    if (mainWindow) await dialog.showMessageBox(mainWindow, options); else await dialog.showMessageBox(options);
    return;
  }
  try { await mobileRelay.start(lastDesktopCwd, lastDesktopSessionId || undefined); }
  catch (error) {
    const options: import("electron").MessageBoxOptions = {
      type: "error",
      title: "Mobile Remote Control",
      message: error instanceof Error ? error.message : String(error),
      buttons: ["OK"],
    };
    if (mainWindow) await dialog.showMessageBox(mainWindow, options); else await dialog.showMessageBox(options);
    sendMenuAction("continueLatest");
  }
}

function confirmDiscardSettings(parent?: BrowserWindow | null): boolean {
  if (!settingsDirty) return true;
  const options: MessageBoxSyncOptions = {
    type: "warning",
    title: "Unsaved Settings",
    message: "Discard unsaved settings changes?",
    detail: "Settings, custom instructions, or an unfinished field still has changes.",
    buttons: ["Keep Editing", "Discard Changes"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const choice = parent
    ? dialog.showMessageBoxSync(parent, options)
    : dialog.showMessageBoxSync(options);
  if (choice !== 1) return false;
  settingsDirty = false;
  return true;
}

/** Short-TTL cache for `@` mention tree walks (avoids main-thread stalls). */
const LIST_FILES_CACHE_TTL_MS = 5_000;
const listFilesCache = new TtlLruCache<string, string[]>(32, LIST_FILES_CACHE_TTL_MS);
const clipboardTempRoot = join(tmpdir(), `vibe-clips-${process.pid}`);
const PROJECT_INDEX_MUTATIONS = new Set<RpcMethod>([
  "renameProject",
  "archiveProject",
  "deleteProject",
  "renameSession",
  "deleteSession",
  "archiveSession",
]);
const SESSION_HISTORY_MUTATIONS = new Set<RpcMethod>([
  "renameSession",
  "deleteSession",
  "archiveSession",
]);
const PROJECT_RECOVERY_MUTATIONS = new Set<RpcMethod>(["archiveProject", "deleteProject"]);
const HANDOFF_CONTROL_COMMANDS = new Set<EngineCommand["type"]>([
  "abort",
  "resolve-permission",
  "resolve-plan",
  "resolve-question",
  "resolve-external-capability",
]);

/**
 * Treat the host project index as a capability source, but discard stale or
 * malformed roots before exposing them to the renderer. The runtime guard
 * validates the nested summary contract; this second gate ensures a project is
 * an absolute directory that still exists on this machine.
 */
function authorizeProjectIndex(value: unknown): ProjectSummary[] {
  if (!isProjectSummaryArray(value)) throw new Error("Engine returned an invalid project index");
  const projects = value.filter((project) => {
    if (!project.cwd || !isAbsolute(project.cwd)) return false;
    try {
      return statSync(project.cwd).isDirectory();
    } catch {
      return false;
    }
  });
  for (const project of projects) projectCwdAllowlist.add(project.cwd);
  return projects;
}

function listProjectFilesCached(cwd: string): string[] {
  const now = Date.now();
  const hit = listFilesCache.get(cwd);
  if (hit) return hit;
  const paths = listProjectFiles(cwd, {
    maxFiles: 2000,
    maxDepth: 6,
    readdir: (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true }).map((d) => ({
          name: d.name,
          isDirectory: d.isDirectory(),
        }));
      } catch {
        return [];
      }
    },
  });
  listFilesCache.set(cwd, paths, now);
  return paths;
}

/** Unpackaged runs use Electron's default dock icon unless we set one explicitly. */
function applyDevDockIcon(): void {
  if (process.platform !== "darwin" || !app.dock || app.isPackaged) return;
  const candidates = [
    join(app.getAppPath(), "assets", "icon.png"),
    join(__dirname, "../../assets/icon.png"),
  ];
  const iconPath = candidates.find((path) => existsSync(path));
  if (!iconPath) return;
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) app.dock.setIcon(image);
}

function inbound(value: unknown): HostInbound | null {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? decodeInbound(encoded) : null;
  } catch {
    return null;
  }
}

function openSafeExternal(value: string): void {
  const safeUrl = safeExternalUrl(value);
  if (!safeUrl) return;
  void shell.openExternal(safeUrl).catch((error) => {
    console.warn(`Could not open external URL ${safeUrl}:`, error);
  });
}

function applyMacChrome(win: BrowserWindow): void {
  if (process.platform !== "darwin") return;
  win.setWindowButtonVisibility(true);
  win.webContents.once("did-finish-load", () => {
    void win.webContents.executeJavaScript(
      `document.documentElement.dataset.platform = "darwin"`,
    );
    void (async () => {
      try {
        const { default: liquidGlass } = await import("electron-liquid-glass");
        if (!liquidGlass.isGlassSupported()) return;
        const tintColor = nativeTheme.shouldUseDarkColors ? "#0a0a0a33" : "#f5f5f528";
        const glassId = liquidGlass.addView(win.getNativeWindowHandle(), {
          cornerRadius: 12,
          tintColor,
        });
        if (glassId < 0) return;
        liquidGlass.unstable_setVariant(glassId, liquidGlass.GlassMaterialVariant.sidebar);
        void win.webContents.executeJavaScript(
          `document.documentElement.classList.add("glass","electron-transparent")`,
        );
      } catch (err) {
        console.warn("liquid glass unavailable:", err);
      }
    })();
  });
}


/**
 * In dev mode Vite injects inline scripts (React refresh preamble, HMR
 * client) that the production CSP (`script-src 'self'` in index.html) would
 * block. Relax the policy only when a dev server URL is present so the strict
 * production CSP is untouched. The override uses onHeadersReceived so it
 * applies to every dev-server response, not just the initial HTML.
 */
function configureDevCsp(): void {
  if (!process.env.ELECTRON_RENDERER_URL) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:",
        ],
      },
    });
  });
}


/**
 * Build the application menu — standard macOS/Windows roles plus app-specific
 * actions (Open Project, Settings, Git). Without a custom menu, Electron's
 * default lacks app-specific items and some role shortcuts (⌘W, ⌘Q) don't
 * map to the right actions.
 */
function buildApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const menu = Menu.buildFromTemplate([
    // ── App menu (macOS only — the first item gets the app name) ────────
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" as const },
            { type: "separator" as const },
            {
              label: "Settings…",
              accelerator: "CmdOrCtrl+,",
              click: () => sendMenuAction("toggleSettings"),
            },
            { type: "separator" as const },
            { role: "services" as const },
            { type: "separator" as const },
            { role: "hide" as const },
            { role: "hideOthers" as const },
            { role: "unhide" as const },
            { type: "separator" as const },
            { role: "quit" as const },
          ],
        }]
      : []),
    // ── File ────────────────────────────────────────────────────────────
    {
      label: "File",
      submenu: [
        {
          label: "New Session",
          accelerator: "CmdOrCtrl+N",
          click: () => sendMenuAction("newSession"),
        },
        {
          label: "Open Project…",
          // Cmd/Ctrl+O belongs to the transcript's established fold-all
          // contract. Keep project opening discoverable in the File menu
          // without registering a competing native accelerator.
          click: () => sendMenuAction("openProject"),
        },
        {
          label: "Continue Latest Session",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => sendMenuAction("continueLatest"),
        },
        { type: "separator" as const },
        { role: "close" as const },
      ],
    },
    // ── Edit (standard clipboard roles) ────────────────────────────────
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
      ],
    },
    // ── View ────────────────────────────────────────────────────────────
    {
      label: "View",
      submenu: [
        // Dev-only: reload/devtools desync engine vs renderer in packaged builds,
        // and Ctrl+Shift+I collides with Toggle Inspector on Windows/Linux.
        ...(!app.isPackaged
          ? [
              { role: "reload" as const },
              { role: "forceReload" as const },
              {
                role: "toggleDevTools" as const,
                // Ctrl+Shift+I is the app's Session Inspector shortcut on
                // Windows/Linux. Alt keeps DevTools available in development
                // without making Electron choose between duplicate bindings.
                accelerator: "CmdOrCtrl+Alt+I",
              },
              { type: "separator" as const },
            ]
          : []),
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    // ── Tools (app-specific) ────────────────────────────────────────────
    {
      label: "Tools",
      submenu: [
        ...(!isMac ? [{
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => sendMenuAction("toggleSettings"),
        }] : []),
        {
          label: "Git…",
          accelerator: "CmdOrCtrl+Shift+B",
          click: () => sendMenuAction("toggleGit"),
        },
        {
          label: "Toggle Inspector",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => sendMenuAction("toggleInspector"),
        },
        { type: "separator" as const },
        {
          label: "Terminal",
          accelerator: "CmdOrCtrl+J",
          click: () => sendMenuAction("toggleTerminal"),
        },
        {
          label: "Background Jobs",
          accelerator: "CmdOrCtrl+Shift+J",
          click: () => sendMenuAction("toggleJobs"),
        },
        { type: "separator" as const },
        {
          label: "Continue on Phone…",
          click: () => void startMobileRemoteControl(),
        },
      ],
    },
    // ── Window ──────────────────────────────────────────────────────────
    {
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        ...(isMac ? [{ type: "separator" as const }, { role: "front" as const }] : []),
      ],
    },
    {
      role: "help" as const,
      submenu: [
        {
          label: "Check for Updates…",
          click: () => void appUpdater?.check(true),
        },
        { type: "separator" as const },
        {
          label: "Keyboard Shortcuts",
          accelerator: "CmdOrCtrl+/",
          click: () => sendMenuAction("showKeys"),
        },
        { type: "separator" as const },
        {
          label: "Vibe Codr Documentation",
          click: () => openSafeExternal("https://github.com/robzilla1738/vibe-codr#readme"),
        },
        {
          label: "Report an Issue…",
          click: () => openSafeExternal("https://github.com/robzilla1738/vibe-codr/issues/new"),
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

function createWindow(): void {
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: isMac ? "#00000000" : "#0a0a0a",
    transparent: isMac,
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openSafeExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow?.webContents.getURL();
    try {
      const nextUrl = new URL(url);
      const currentUrl = current ? new URL(current) : null;
      // In-document navigation is used by accessibility skip links in both the
      // packaged file URL and the Vite dev-server URL.
      if (
        currentUrl &&
        nextUrl.protocol === currentUrl.protocol &&
        nextUrl.host === currentUrl.host &&
        nextUrl.pathname === currentUrl.pathname &&
        nextUrl.search === currentUrl.search &&
        nextUrl.hash !== currentUrl.hash
      ) return;
    } catch {
      // Invalid navigation is denied below.
    }
    event.preventDefault();
    openSafeExternal(url);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  if (isMac) applyMacChrome(mainWindow);

  setMainWindow(mainWindow);

  mainWindow.on("close", (event) => {
    if (!quitting && !confirmDiscardSettings(mainWindow)) event.preventDefault();
  });

  mainWindow.on("closed", () => {
    settingsDirty = false;
    mainWindow = null;
    setMainWindow(null);
  });
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, ...args);
  } catch {
    // The window can be destroyed between the guards and send during shutdown.
  }
}

function sendMenuAction(action: MenuAction): void {
  sendToRenderer("menu:action", action);
}

const terminalManager = new TerminalManager((event) => sendToRenderer("terminal:event", event));

function wireBridge(): void {
  bridge.onEvent = (event) => {
    cloudManager.observeEngineEvent(event);
    sendToRenderer("engine:event", event);
  };
  bridge.onFatal = (message) => sendToRenderer("engine:fatal", message);
  bridge.onReady = (sessionId) => { lastDesktopSessionId = sessionId; sendToRenderer("engine:ready", sessionId); };
  bridge.onTerminalEvent = (event) => sendToRenderer("terminal:event", event);
  cloudManager.onStatus = (status) => sendToRenderer("cloud:status", status);
}

function registerIpc(): void {
  ipcMain.on("settings:dirty", (event, dirty: unknown) => {
    assertTrustedSender(event.sender);
    settingsDirty = dirty === true;
  });

  ipcMain.handle(
    "engine:bootstrap",
    async (
      event,
      opts: {
        cwd: string;
        resume?: string;
        continueLatest?: boolean;
        model?: string;
        mode?: "plan" | "execute" | "yolo";
      },
    ) => {
      assertTrustedIpc(event);
      if (cloudManager.ownershipTransitioning) {
        return { ok: false as const, error: "Session handoff is in progress; wait for it to finish before switching sessions" };
      }
      // Map renderer `continueLatest` → host protocol field `continue`.
      // Spreading opts leaves `continueLatest` on the object; decodeInbound only
      // understands `continue`, so the flag was previously always dropped.
      if (!opts || typeof opts.cwd !== "string") {
        return { ok: false as const, error: "Invalid bootstrap request" };
      }
      const message = inbound({
        op: "bootstrap",
        cwd: opts.cwd,
        resume: opts.resume,
        continue: opts.continueLatest,
        model: opts.model,
        mode: opts.mode,
      });
      if (message?.op !== "bootstrap") {
        return { ok: false as const, error: "Invalid bootstrap request" };
      }
      // Renderer persistence is a restore hint, not a filesystem capability.
      // Cwds are authorized only by the main-owned folder picker, Chats
      // creation, or the validated host project index.
      if (!isAllowedCwd(message.cwd)) {
        return {
          ok: false as const,
          error: "Project is not authorized. Open it from Recent Projects or Open Project.",
        };
      }
      try {
        const sessionId = await bridge.start({
          cwd: message.cwd,
          resume: message.resume,
          continueLatest: message.continue,
          model: message.model,
          mode: message.mode,
        });
        // Only after a successful host start — failed bootstrap must not widen
        // git/config/fs IPC to an unopened path.
        projectCwdAllowlist.add(message.cwd);
        lastDesktopCwd = message.cwd;
        lastDesktopSessionId = sessionId;
        return { ok: true as const, sessionId, launch: bridge.lastLaunchDescription };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
          stderr: bridge.lastStderr,
          launch: bridge.lastLaunchDescription,
        };
      }
    },
  );

  ipcMain.handle("engine:send", (event, command: EngineCommand) => {
    assertTrustedIpc(event);
    if (cloudManager.ownershipTransitioning && !HANDOFF_CONTROL_COMMANDS.has(command?.type)) {
      return { ok: false as const, error: "Session handoff is in progress; your message was not sent" };
    }
    const message = inbound({ op: "send", command });
    if (message?.op !== "send") return { ok: false as const, error: "Invalid engine command" };
    if (bridge.isRemote && (
      message.command.type === "set-model"
      || message.command.type === "set-subagent-model"
      || message.command.type === "set-agent-model"
      || message.command.type === "run-slash"
        && message.command.name === "model"
        && !/^(?:|refresh(?:\s|$))/i.test(message.command.args.trim())
      || message.command.type === "run-slash"
        && message.command.name === "vision"
        && /^model(?:\s|$)/i.test(message.command.args.trim())
    )) {
      return { ok: false as const, error: "Return this session to Local before changing model access" };
    }
    try {
      bridge.send(message.command);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("engine:rpc", async (event, method: RpcMethod, params?: Record<string, unknown>) => {
    assertTrustedIpc(event);
    const message = inbound({ op: "rpc", id: 1, method, ...(params ? { params } : {}) });
    if (message?.op !== "rpc") return { ok: false as const, error: "Invalid RPC request" };
    if (!isRendererRpcMethod(message.method)) {
      return { ok: false as const, error: "This engine RPC is restricted to the main-process handoff controller" };
    }
    try {
      let historyMutation: { cwd: string; sessionId?: string } | null = null;
      let rpcParams = message.params;
      if (PROJECT_INDEX_MUTATIONS.has(message.method)) {
        const cwd = message.params?.cwd;
        if (typeof cwd !== "string" || !isAllowedProjectRoot(cwd)) {
          return {
            ok: false as const,
            error: "Project history changes are limited to opened or recent projects",
          };
        }
        if (SESSION_HISTORY_MUTATIONS.has(message.method) || PROJECT_RECOVERY_MUTATIONS.has(message.method)) {
          const rawSessionId = SESSION_HISTORY_MUTATIONS.has(message.method)
            ? message.params?.id
            : undefined;
          const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : undefined;
          if (sessionId !== undefined) {
            rpcParams = { ...message.params, id: sessionId };
          }
          historyMutation = {
            cwd,
            ...(sessionId !== undefined ? { sessionId } : {}),
          };
        }
      }
      const isProjectIndexRpc = message.method === "listProjects"
        || PROJECT_INDEX_MUTATIONS.has(message.method);
      const isProviderAuthRpc = message.method === "providerAuthStatus"
        || message.method === "beginProviderAuth"
        || message.method === "cancelProviderAuth"
        || message.method === "logoutProviderAuth";
      const rawValue = isProviderAuthRpc
        ? await bridge.providerAuthRpc(message.method, rpcParams)
        : isProjectIndexRpc
          ? historyMutation
            ? await cloudManager.runHistoryMutation(
                historyMutation.cwd,
                historyMutation.sessionId,
                () => bridge.projectIndexRpc(message.method, rpcParams),
              )
            : await bridge.projectIndexRpc(message.method, rpcParams)
          : await bridge.rpc(message.method, rpcParams);
      const value = message.method === "listProjects"
        ? authorizeProjectIndex(rawValue)
        : rawValue;
      return { ok: true as const, value };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("engine:stop", async (event) => {
    assertTrustedIpc(event);
    await bridge.stop();
    return { ok: true as const };
  });

  ipcMain.handle("cloud:settings", async (event) => {
    assertTrustedIpc(event);
    try { return { ok: true as const, value: await cloudManager.settings() }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle("cloud:updateSettings", async (event, patch) => {
    assertTrustedIpc(event);
    try { return { ok: true as const, value: await cloudManager.updateSettings(patch ?? {}) }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle("cloud:connect", async (event, provider: unknown, credentials: unknown) => {
    assertTrustedIpc(event);
    if (provider !== "e2b" && provider !== "vercel") return { ok: false as const, error: "Unknown cloud provider" };
    if (!credentials || typeof credentials !== "object") return { ok: false as const, error: "Credentials are required" };
    try { return { ok: true as const, value: await cloudManager.connect(provider, credentials as never) }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle("cloud:disconnect", async (event, provider: unknown) => {
    assertTrustedIpc(event);
    if (provider !== "e2b" && provider !== "vercel") return { ok: false as const, error: "Unknown cloud provider" };
    try { return { ok: true as const, value: await cloudManager.disconnect(provider) }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle("cloud:test", async (event, provider: unknown) => {
    assertTrustedIpc(event);
    if (provider !== "e2b" && provider !== "vercel") return { ok: false as const, error: "Unknown cloud provider" };
    try { return { ok: true as const, value: await cloudManager.test(provider) }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle("cloud:saveBinding", async (event, input: unknown) => {
    assertTrustedIpc(event);
    if (!input || typeof input !== "object") return { ok: false as const, error: "Credential binding is required" };
    const value = input as { id?: string; label?: unknown; kind?: unknown; value?: unknown };
    if (typeof value.label !== "string" || value.kind !== "environment" || typeof value.value !== "string") return { ok: false as const, error: "Invalid credential binding" };
    try { return { ok: true as const, value: await cloudManager.saveCredentialBinding({ id: value.id, label: value.label, kind: "environment", value: value.value }) }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle("cloud:removeBinding", async (event, id: unknown) => {
    assertTrustedIpc(event);
    if (typeof id !== "string" || !id) return { ok: false as const, error: "Credential binding ID is required" };
    try { return { ok: true as const, value: await cloudManager.removeCredentialBinding(id) }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle("cloud:listSessions", async (event) => {
    assertTrustedIpc(event);
    try { return { ok: true as const, value: await cloudManager.listSessions() }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle("cloud:deleteCopy", async (event, sessionId: unknown) => {
    assertTrustedIpc(event);
    if (typeof sessionId !== "string" || !sessionId) return { ok: false as const, error: "Session ID is required" };
    try {
      await cloudManager.deleteCloudCopy(sessionId);
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("cloud:recoverLost", async (event, sessionId: unknown) => {
    assertTrustedIpc(event);
    if (typeof sessionId !== "string" || !sessionId) return { ok: false as const, error: "Session ID is required" };
    try { return { ok: true as const, value: await cloudManager.recoverLostSession(sessionId) }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle("cloud:handoff", async (event, request) => {
    assertTrustedIpc(event);
    if (!request || typeof request.cwd !== "string" || !isAllowedCwd(request.cwd)) {
      return { ok: false as const, error: "Cloud handoff is limited to the active authorized project" };
    }
    if (request.provider !== "e2b" && request.provider !== "vercel") return { ok: false as const, error: "Unknown cloud provider" };
    if (request.includeModelCredentials !== undefined && typeof request.includeModelCredentials !== "boolean") {
      return { ok: false as const, error: "Invalid model credential transfer preference" };
    }
    try { return { ok: true as const, value: await cloudManager.handoffToCloud(request) }; }
    catch (error) {
      const details = cloudFailureDetails(error);
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
        ...(details ? { details } : {}),
      };
    }
  });

  ipcMain.handle("cloud:reconnect", async (event, sessionId: unknown) => {
    assertTrustedIpc(event);
    if (typeof sessionId !== "string" || !sessionId) return { ok: false as const, error: "Session ID is required" };
    if (cloudManager.ownershipTransitionActive) {
      return { ok: false as const, error: "Session handoff is in progress; wait for it to finish before reconnecting" };
    }
    try { return { ok: true as const, sessionId: await cloudManager.reconnect(sessionId) }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle("cloud:resumeLocal", async (event, sessionId: unknown, keepCloudCopy: unknown) => {
    assertTrustedIpc(event);
    if (typeof sessionId !== "string" || !sessionId) return { ok: false as const, error: "Session ID is required" };
    try {
      const value = await cloudManager.resumeLocally(sessionId, keepCloudCopy === true);
      // This path is created and verified by the main-process manager. Admit it
      // only after a successful return so protected project IPC remains usable
      // when divergence intentionally resumes in a review worktree.
      projectCwdAllowlist.add(value.cwd);
      return { ok: true as const, value };
    }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle("dialog:openProject", async (event) => {
    assertTrustedIpc(event);
    const parent = getMainWindow() ?? mainWindow;
    const dialogOpts = {
      properties: ["openDirectory" as const, "createDirectory" as const],
      title: "Open Project",
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (result.canceled || !result.filePaths[0]) return null;
    const chosen = result.filePaths[0];
    projectCwdAllowlist.add(chosen);
    return chosen;
  });

  ipcMain.handle("shell:openExternal", async (event, url: string) => {
    assertTrustedIpc(event);
    const safeUrl = safeExternalUrl(url);
    if (!safeUrl) throw new Error("Unsupported external URL");
    await shell.openExternal(safeUrl);
  });

  ipcMain.handle("shell:showItem", async (event, path: string) => {
    assertTrustedIpc(event);
    if (typeof path !== "string" || !path) throw new Error("Invalid item path");
    const abs = resolve(path);
    if (!isAllowedRevealPath(abs, clipboardTempRoot)) {
      throw new Error("Reveal is limited to opened projects and this app's clipboard files");
    }
    shell.showItemInFolder(abs);
  });

  ipcMain.handle(
    "clipboard:paste",
    async (event, opts?: { cwd?: string }) => {
      assertTrustedIpc(event);
      if (opts !== undefined && (typeof opts !== "object" || (opts.cwd !== undefined && typeof opts.cwd !== "string"))) {
        return { kind: "error" as const, error: "Invalid clipboard request" };
      }
      try {
        const img = clipboard.readImage();
        if (!img.isEmpty()) {
          const png = img.toPNG();
          const CLIPBOARD_MAX_BYTES = 12 * 1024 * 1024; // 12 MiB
          if (png.byteLength > CLIPBOARD_MAX_BYTES) {
            return {
              kind: "error" as const,
              error: `Clipboard image exceeds ${CLIPBOARD_MAX_BYTES} bytes`,
            };
          }
          if (opts?.cwd && !isAllowedCwd(opts.cwd)) {
            return { kind: "error" as const, error: "Clipboard write is limited to opened project roots" };
          }
          const filename = `vibe-clip-${randomUUID()}.png`;
          if (opts?.cwd && bridge.isRemote) {
            const path = `.vibe/clipboard/${filename}`;
            const uploaded = await bridge.remoteWriteFile(opts.cwd, path, png, 0o600);
            return uploaded.ok
              ? { kind: "image" as const, path }
              : { kind: "error" as const, error: uploaded.error };
          }
          let dir = clipboardTempRoot;
          let abs = join(dir, filename);
          if (opts?.cwd) {
            const relativePath = join(".vibe", "clipboard", filename);
            const located = resolveWritablePathInsideRoot(opts.cwd, relativePath, {
              existsSync,
              lstatSync,
              realpathSync,
            });
            if (!located.ok) return { kind: "error" as const, error: located.error };
            abs = located.target;
            dir = dirname(abs);
          }
          await mkdir(dir, { recursive: true, mode: 0o700 });
          try {
            await chmod(dir, 0o700);
          } catch {
            /* best-effort on platforms without POSIX modes */
          }
          await writeFile(abs, png, { mode: 0o600 });
          const path = opts?.cwd ? join(".vibe", "clipboard", filename) : abs;
          return { kind: "image" as const, path };
        }
        const CLIPBOARD_TEXT_MAX = 2 * 1024 * 1024; // 2 MiB — match image defense-in-depth
        const text = clipboard.readText();
        if (!text) return { kind: "none" as const };
        if (Buffer.byteLength(text, "utf8") > CLIPBOARD_TEXT_MAX) {
          return {
            kind: "error" as const,
            error: `Clipboard text exceeds ${CLIPBOARD_TEXT_MAX} bytes`,
          };
        }
        return { kind: "text" as const, text };
      } catch (error) {
        return {
          kind: "error" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle("clipboard:writeText", (event, opts?: { text?: string }) => {
    assertTrustedIpc(event);
    const text = opts?.text;
    if (typeof text !== "string") {
      return { ok: false as const, error: "Invalid clipboard text" };
    }
    const CLIPBOARD_TEXT_MAX = 2 * 1024 * 1024;
    if (Buffer.byteLength(text, "utf8") > CLIPBOARD_TEXT_MAX) {
      return {
        ok: false as const,
        error: `Clipboard text exceeds ${CLIPBOARD_TEXT_MAX} bytes`,
      };
    }
    try {
      clipboard.writeText(text);
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("editor:compose", async (event, draft: string) => {
    assertTrustedIpc(event);
    if (typeof draft !== "string") return { ok: false, reason: "failed" as const, error: "Invalid editor draft" };
    if (Buffer.byteLength(draft, "utf8") > EDITOR_DRAFT_MAX_BYTES) {
      return {
        ok: false,
        reason: "failed" as const,
        error: `Editor draft exceeds ${EDITOR_DRAFT_MAX_BYTES} bytes`,
      };
    }
    const EDITOR_TIMEOUT_MS = 30 * 60 * 1000; // long but finite — hung editors must not pin IPC forever
    const result = await composeInEditor({
      editor: process.env.VISUAL || process.env.EDITOR,
      draft,
      spawn: (command, args) =>
        new Promise<number>((resolve, reject) => {
          const child = spawn(command, args, {
            stdio: "inherit",
            env: enrichedEnv(),
          });
          let forceTimer: NodeJS.Timeout | null = null;
          const timer = setTimeout(() => {
            try {
              child.kill("SIGTERM");
              forceTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
            } catch {
              /* ignore */
            }
            reject(new Error("External editor timed out"));
          }, EDITOR_TIMEOUT_MS);
          const clearTimers = () => {
            clearTimeout(timer);
            if (forceTimer) clearTimeout(forceTimer);
          };
          child.once("error", (err) => {
            clearTimers();
            reject(err);
          });
          child.once("exit", (code) => {
            clearTimers();
            resolve(code ?? 1);
          });
        }),
    });
    if (result.kind === "replaced") return { ok: true, text: result.draft };
    if (result.kind === "failed") return { ok: false, reason: "failed", error: result.reason };
    if (result.kind === "unavailable") return { ok: false, reason: "no-editor" };
    return { ok: false, reason: "kept" };
  });

  ipcMain.handle("app:getShellInfo", (event) => {
    assertTrustedIpc(event);
    return {
      version: app.getVersion(),
      lastLaunch: bridge.lastLaunchDescription || undefined,
    };
  });

  ipcMain.handle("terminal:open", (event, request) => {
    assertTrustedIpc(event);
    if (
      !request ||
      typeof request !== "object" ||
      typeof request.cwd !== "string" ||
      !Number.isFinite(request.cols) ||
      !Number.isFinite(request.rows)
    ) {
      return { ok: false as const, error: "Invalid terminal request" };
    }
    const terminalRequest = { cwd: request.cwd, cols: request.cols, rows: request.rows };
    return bridge.isRemote
      ? bridge.remoteTerminalOpen(terminalRequest)
      : terminalManager.open(terminalRequest);
  });

  ipcMain.handle("terminal:write", (event, request) => {
    assertTrustedIpc(event);
    if (!request || typeof request !== "object" || typeof request.id !== "string" || typeof request.data !== "string") {
      return { ok: false as const, error: "Invalid terminal input" };
    }
    return bridge.isRemote
      ? bridge.remoteTerminalWrite(request.id, request.data)
      : terminalManager.write(request.id, request.data);
  });

  ipcMain.handle("terminal:resize", (event, request) => {
    assertTrustedIpc(event);
    if (
      !request ||
      typeof request !== "object" ||
      typeof request.id !== "string" ||
      !Number.isFinite(request.cols) ||
      !Number.isFinite(request.rows)
    ) {
      return { ok: false as const, error: "Invalid terminal size" };
    }
    return bridge.isRemote
      ? bridge.remoteTerminalResize(request.id, request.cols, request.rows)
      : terminalManager.resize(request.id, request.cols, request.rows);
  });

  ipcMain.handle("app:getPath", (event, name: "home" | "userData") => {
    assertTrustedIpc(event);
    if (name !== "home" && name !== "userData") throw new Error("Unsupported app path");
    return app.getPath(name);
  });

  /** One-off chats workspace (`~/.vibe/chats`) — not a code project. */
  ipcMain.handle("app:ensureChatsDir", async (event) => {
    assertTrustedIpc(event);
    const dir = chatsCwdFromHome(homedir());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await chmod(dir, 0o700);
    } catch {
      /* best-effort on platforms without POSIX modes */
    }
    projectCwdAllowlist.add(dir);
    return dir;
  });

  ipcMain.on("app:quit", (event) => {
    assertTrustedSender(event.sender);
    app.quit();
  });

  ipcMain.handle(
    "fs:listFiles",
    async (event, opts: { cwd: string; query: string; limit?: number }) => {
      assertTrustedIpc(event);
      if (!opts || typeof opts.cwd !== "string" || typeof opts.query !== "string") return [];
      if (!isAllowedCwd(opts.cwd)) return [];
      const limit = Math.min(100, Math.max(1, Number.isFinite(opts.limit) ? Math.trunc(opts.limit!) : 40));
      try {
        if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) return [];
      } catch {
        return [];
      }
      // Cache tree walks briefly so repeated @ mentions don't re-stat the tree.
      const all = listProjectFilesCached(opts.cwd);
      return rankPaths(all, opts.query, limit);
    },
  );

  ipcMain.handle(
    "fs:readTextFile",
    async (
      event,
      opts: { cwd: string; path: string; maxBytes?: number },
    ): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; error: string }> => {
      assertTrustedIpc(event);
      if (!opts || typeof opts.cwd !== "string" || typeof opts.path !== "string") {
        return { ok: false, error: "Invalid path" };
      }
      if (!bridge.isRemote && !isAllowedCwd(opts.cwd)) {
        return { ok: false, error: "cwd is not an opened project root" };
      }
      const maxBytes = Math.min(
        256_000,
        Math.max(1024, Number.isFinite(opts.maxBytes) ? Math.trunc(opts.maxBytes!) : 65_536),
      );
      if (bridge.isRemote) {
        return bridge.remoteReadTextFile(opts.cwd, opts.path, maxBytes);
      }
      const located = resolvePathInsideRoot(opts.cwd, opts.path, {
        realpathSync,
        existsSync,
        isFile: (p) => {
          try {
            return statSync(p).isFile();
          } catch {
            return false;
          }
        },
      });
      if (!located.ok) return { ok: false, error: located.error };
      // Byte-capped open/read — never load multi-GB artifacts into main memory.
      return readTextFileCapped(located.target, maxBytes, {
        open: async (path, flags) => {
          const fh = await fsOpen(path, flags);
          return {
            read: (buffer, offset, length, position) =>
              fh.read(buffer, offset, length, position),
            close: () => fh.close(),
          };
        },
      });
    },
  );

  // Config and git IPC are registered by their feature modules.
  registerConfigIpc(assertTrustedIpc);
  registerGitIpc(assertTrustedIpc);
}

// Single-instance: a second launch focuses the existing window instead of
// spawning another engine host and racing config/session state.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // After last window close on macOS, mainWindow is null — recreate so a
    // second launch is not a silent no-op until Dock activate.
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    configureDevCsp();
    // Local-only crash breadcrumbs (version + path) — no prompt content, no upload
    // without an explicit submit URL (signing/update channel remains credential-gated).
    try {
      crashReporter.start({
        productName: "Vibe Codr",
        companyName: "Vibe Codr",
        submitURL: "",
        uploadToServer: false,
        compress: true,
        ignoreSystemCrashHandler: false,
        extra: {
          shellVersion: app.getVersion(),
        },
      });
    } catch (err) {
      console.warn("crashReporter unavailable:", err);
    }
    // Defense-in-depth: deny Chromium permission prompts (media, geolocation, …)
    // this shell never needs — a compromised dependency cannot elevate them.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    buildApplicationMenu();
    applyDevDockIcon();
    wireBridge();
    registerIpc();
    createWindow();
    appUpdater = createAppUpdater({
      getWindow: () => mainWindow,
      prepareToInstall: prepareToInstallUpdate,
    });
    const updateTimer = setTimeout(() => void appUpdater?.check(false), 10_000);
    updateTimer.unref();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

let quitting = false;
let allowUpdaterQuit = false;
let quitCleanupPromise: Promise<void> | null = null;

/**
 * Quit budget: disposeForQuit uses a short finalize window then always reaps
 * with SIGTERM→SIGKILL. The outer ceiling is a last-resort so a wedged OS
 * wait cannot pin the app forever.
 */
const QUIT_HARD_CEILING_MS = 8_000;

function cleanupForQuit(): Promise<void> {
  if (quitCleanupPromise) return quitCleanupPromise;
  terminalManager.dispose();
  quitCleanupPromise = Promise.race([
    (async () => {
      await mobileRelay.stopForQuit();
      // Always try to reap when we still own a child (isRunning tracks exit
      // codes, not proc.killed — soft-kill alone must not skip cleanup).
      if (bridge.isRunning) {
        try {
          await bridge.disposeForQuit();
        } catch {
          /* stop must still have been attempted inside disposeForQuit */
          try {
            await bridge.stop();
          } catch {
            /* ignore */
          }
        }
      }
      // Clean up per-session clipboard temp PNGs (TUI parity: cleanupClipboardTempDir).
      try {
        await rm(clipboardTempRoot, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
    })(),
    new Promise<void>((resolve) => setTimeout(resolve, QUIT_HARD_CEILING_MS)),
  ]);
  return quitCleanupPromise;
}

async function prepareToInstallUpdate(): Promise<boolean> {
  if (quitting) return false;
  if (!confirmDiscardSettings(mainWindow)) return false;
  quitting = true;
  await cleanupForQuit();
  // quitAndInstall closes windows before emitting before-quit. Mark its quit as
  // trusted only after engine/PTY cleanup has completed.
  allowUpdaterQuit = true;
  return true;
}

app.on("before-quit", async (e) => {
  if (allowUpdaterQuit) return;
  // Guard against re-entrant before-quit (e.g. Cmd+Q while already quitting,
  // or app.exit firing a second before-quit after cleanup completes).
  if (quitting) {
    // A second Cmd+Q must not bypass the cleanup already in flight. `app.exit`
    // below exits directly and does not re-enter this cancellable event.
    e.preventDefault();
    return;
  }
  if (!confirmDiscardSettings(mainWindow)) {
    e.preventDefault();
    return;
  }
  quitting = true;
  e.preventDefault();
  await cleanupForQuit();
  app.exit(0);
});

app.on("window-all-closed", () => {
  // Local engines are finalized, while a cloud-owned session is disconnected
  // without sending shutdown so its turn, PTYs, jobs, and replay keep running.
  if (process.platform === "darwin") {
    void bridge.disposeForQuit().catch(() => undefined);
    return;
  }
  app.quit();
});
