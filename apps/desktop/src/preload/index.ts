import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { EngineCommand } from "../shared/commands";
import type {
  CloudFailureDetails,
  CloudProviderId,
  CloudSessionCatalogEntry,
  CloudSettingsPublic,
  CloudStatusEvent,
  ProviderCredentials,
} from "../shared/cloud";
import type {
  ConfigReadResult,
  ConfigScope,
  ConfigWriteRequest,
  MemoryFileRequest,
  MemoryFileResult,
  MemoryWriteRequest,
} from "../shared/config-schema";
import type {
  GhPrCreateRequest,
  GhPrCreateResult,
  GhPrListResult,
  GitCheckoutRequest,
  GitCommitRequest,
  GitCreateBranchRequest,
  GitDeleteBranchRequest,
  GitFileDiffResult,
  GitFullStatus,
  GitMergeRequest,
  GitPullRequest,
  GitPushRequest,
} from "../shared/git-types";
import { isMenuAction, type MenuAction } from "../shared/menu-actions";
import type { ProjectSummary, RpcMethod } from "../shared/protocol";
import type {
  TerminalCommandResult,
  TerminalEvent,
  TerminalOpenRequest,
  TerminalOpenResult,
} from "../shared/terminal";

export interface BootstrapOpts {
  cwd: string;
  resume?: string;
  continueLatest?: boolean;
  model?: string;
  mode?: "plan" | "execute" | "yolo";
}

export interface GitOperationResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export interface VibeApi {
  bootstrap(opts: BootstrapOpts): Promise<
    | { ok: true; sessionId: string; launch: string }
    | { ok: false; error: string; stderr?: string; launch?: string }
  >;
  send(command: EngineCommand): Promise<{ ok: true } | { ok: false; error: string }>;
  rpc(method: RpcMethod, params?: Record<string, unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
  listProjects(): Promise<
    { ok: true; value: ProjectSummary[] } | { ok: false; error: string }
  >;
  renameProject(opts: { cwd: string; name: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  archiveProject(opts: { cwd: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  deleteProject(opts: { cwd: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  renameSession(opts: { cwd: string; id: string; title: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  deleteSession(opts: { cwd: string; id: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  archiveSession(opts: { cwd: string; id: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  stop(): Promise<{ ok: true }>;
  quit(): void;
  onEvent(cb: (event: unknown) => void): () => void;
  onReady(cb: (sessionId: string) => void): () => void;
  onFatal(cb: (message: string) => void): () => void;
  onMenuAction(cb: (action: MenuAction) => void): () => void;
  cloudSettings(): Promise<{ ok: true; value: CloudSettingsPublic } | { ok: false; error: string }>;
  updateCloudSettings(patch: Partial<CloudSettingsPublic>): Promise<{ ok: true; value: CloudSettingsPublic } | { ok: false; error: string }>;
  connectCloudProvider<P extends CloudProviderId>(provider: P, credentials: NonNullable<ProviderCredentials[P]>): Promise<{ ok: true; value: CloudSettingsPublic } | { ok: false; error: string }>;
  disconnectCloudProvider(provider: CloudProviderId): Promise<{ ok: true; value: CloudSettingsPublic } | { ok: false; error: string }>;
  testCloudProvider(provider: CloudProviderId): Promise<{ ok: true; value: { ok: boolean; error?: string } } | { ok: false; error: string }>;
  saveCloudCredentialBinding(input: { id?: string; label: string; kind: "environment"; value: string }): Promise<{ ok: true; value: CloudSettingsPublic } | { ok: false; error: string }>;
  removeCloudCredentialBinding(id: string): Promise<{ ok: true; value: CloudSettingsPublic } | { ok: false; error: string }>;
  listCloudSessions(): Promise<{ ok: true; value: CloudSessionCatalogEntry[] } | { ok: false; error: string }>;
  deleteCloudSessionCopy(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  recoverLostCloudSession(sessionId: string): Promise<{ ok: true; value: { sessionId: string; cwd: string } } | { ok: false; error: string }>;
  handoffToCloud(request: { cwd: string; provider: CloudProviderId; instruction?: string; includeModelCredentials?: boolean }): Promise<{ ok: true; value: CloudSessionCatalogEntry } | { ok: false; error: string; details?: CloudFailureDetails }>;
  reconnectCloudSession(sessionId: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  resumeCloudSessionLocally(sessionId: string, keepCloudCopy?: boolean): Promise<{ ok: true; value: { sessionId: string; cwd: string; divergent: boolean; recoveryPath?: string } } | { ok: false; error: string }>;
  onCloudStatus(cb: (event: CloudStatusEvent) => void): () => void;
  /** Synchronize unsaved Settings/Instructions state for native close/quit guards. */
  setSettingsDirty(dirty: boolean): void;
  openProject(): Promise<string | null>;
  /** Ensure `~/.vibe/chats` exists and return its absolute path (one-off conversations). */
  ensureChatsDir(): Promise<string>;
  openExternal(url: string): Promise<void>;
  showItem(path: string): Promise<void>;
  readTextFile(opts: {
    cwd: string;
    path: string;
    maxBytes?: number;
  }): Promise<
    | { ok: true; text: string; truncated: boolean }
    | { ok: false; error: string }
  >;
  composeInEditor(draft: string): Promise<{ ok: boolean; text?: string; reason?: "failed" | "no-editor" | "kept"; error?: string }>;
  getPath(name: "home" | "userData"): Promise<string>;
  getPathForFile(file: File): string;
  listFiles(opts: { cwd: string; query: string; limit?: number }): Promise<string[]>;
  pasteClipboard(cwd?: string): Promise<
    | { kind: "image"; path: string }
    | { kind: "text"; text: string }
    | { kind: "none" }
    | { kind: "error"; error: string }
  >;
  writeClipboardText(text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  globalConfigPath(): Promise<string>;

  // ── Config (settings) ────────────────────────────────────────────────
  readConfig(opts: { scope: ConfigScope; cwd?: string }): Promise<ConfigReadResult | { ok: false; error: string }>;
  writeConfig(req: ConfigWriteRequest): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  projectConfigPath(cwd: string): Promise<string>;
  readMemory(opts: MemoryFileRequest): Promise<MemoryFileResult | { ok: false; error: string }>;
  writeMemory(req: MemoryWriteRequest): Promise<{ ok: true; path: string } | { ok: false; error: string }>;

  // ── Git / GitHub ──────────────────────────────────────────────────────
  gitStatus(cwd: string): Promise<{ ok: true; status: GitFullStatus | null } | { ok: false; error: string }>;
  gitFileDiff(opts: { cwd: string; path: string }): Promise<GitFileDiffResult>;
  gitCreateBranch(req: GitCreateBranchRequest): Promise<GitOperationResult>;
  gitCheckout(req: GitCheckoutRequest): Promise<GitOperationResult>;
  gitDeleteBranch(req: GitDeleteBranchRequest): Promise<GitOperationResult>;
  gitStage(opts: { cwd: string; paths?: string[]; all?: boolean; allIncludingUntracked?: boolean }): Promise<GitOperationResult>;
  gitUnstage(opts: { cwd: string; paths?: string[] }): Promise<GitOperationResult>;
  gitCommit(req: GitCommitRequest): Promise<GitOperationResult>;
  gitMerge(req: GitMergeRequest): Promise<GitOperationResult>;
  gitPush(req: GitPushRequest): Promise<GitOperationResult>;
  gitPull(req: GitPullRequest): Promise<GitOperationResult>;
  gitFetch(opts: { cwd: string; remote?: string }): Promise<GitOperationResult>;
  ghCheckAvailable(): Promise<{ available: boolean }>;
  ghPrList(cwd: string): Promise<GhPrListResult>;
  ghPrCreate(req: GhPrCreateRequest): Promise<GhPrCreateResult>;

  /** Shell version + last host launch description for diagnostics banners. */
  getShellInfo(): Promise<{ version: string; lastLaunch?: string }>;

  // ── Project terminal ────────────────────────────────────────────────
  terminalOpen(opts: TerminalOpenRequest): Promise<TerminalOpenResult>;
  terminalWrite(opts: { id: string; data: string }): Promise<TerminalCommandResult>;
  terminalResize(opts: { id: string; cols: number; rows: number }): Promise<TerminalCommandResult>;
  onTerminalEvent(cb: (event: TerminalEvent) => void): () => void;
}

const api: VibeApi = {
  bootstrap: (opts) => ipcRenderer.invoke("engine:bootstrap", opts),
  send: (command) => ipcRenderer.invoke("engine:send", command),
  rpc: (method, params) => ipcRenderer.invoke("engine:rpc", method, params),
  listProjects: () => ipcRenderer.invoke("engine:rpc", "listProjects"),
  renameProject: (opts) => ipcRenderer.invoke("engine:rpc", "renameProject", opts),
  archiveProject: (opts) => ipcRenderer.invoke("engine:rpc", "archiveProject", opts),
  deleteProject: (opts) => ipcRenderer.invoke("engine:rpc", "deleteProject", opts),
  renameSession: (opts) => ipcRenderer.invoke("engine:rpc", "renameSession", opts),
  deleteSession: (opts) => ipcRenderer.invoke("engine:rpc", "deleteSession", opts),
  archiveSession: (opts) => ipcRenderer.invoke("engine:rpc", "archiveSession", opts),
  stop: () => ipcRenderer.invoke("engine:stop"),
  quit: () => ipcRenderer.send("app:quit"),
  onEvent: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, event: unknown) => cb(event);
    ipcRenderer.on("engine:event", handler);
    return () => ipcRenderer.removeListener("engine:event", handler);
  },
  onReady: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, sessionId: string) => cb(sessionId);
    ipcRenderer.on("engine:ready", handler);
    return () => ipcRenderer.removeListener("engine:ready", handler);
  },
  onFatal: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, message: string) => cb(message);
    ipcRenderer.on("engine:fatal", handler);
    return () => ipcRenderer.removeListener("engine:fatal", handler);
  },
  onMenuAction: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, action: unknown) => {
      if (isMenuAction(action)) cb(action);
    };
    ipcRenderer.on("menu:action", handler);
    return () => ipcRenderer.removeListener("menu:action", handler);
  },
  cloudSettings: () => ipcRenderer.invoke("cloud:settings"),
  updateCloudSettings: (patch) => ipcRenderer.invoke("cloud:updateSettings", patch),
  connectCloudProvider: (provider, credentials) => ipcRenderer.invoke("cloud:connect", provider, credentials),
  disconnectCloudProvider: (provider) => ipcRenderer.invoke("cloud:disconnect", provider),
  testCloudProvider: (provider) => ipcRenderer.invoke("cloud:test", provider),
  saveCloudCredentialBinding: (input) => ipcRenderer.invoke("cloud:saveBinding", input),
  removeCloudCredentialBinding: (id) => ipcRenderer.invoke("cloud:removeBinding", id),
  listCloudSessions: () => ipcRenderer.invoke("cloud:listSessions"),
  deleteCloudSessionCopy: (sessionId) => ipcRenderer.invoke("cloud:deleteCopy", sessionId),
  recoverLostCloudSession: (sessionId) => ipcRenderer.invoke("cloud:recoverLost", sessionId),
  handoffToCloud: (request) => ipcRenderer.invoke("cloud:handoff", request),
  reconnectCloudSession: (sessionId) => ipcRenderer.invoke("cloud:reconnect", sessionId),
  resumeCloudSessionLocally: (sessionId, keepCloudCopy) => ipcRenderer.invoke("cloud:resumeLocal", sessionId, keepCloudCopy),
  onCloudStatus: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, status: Parameters<typeof cb>[0]) => cb(status);
    ipcRenderer.on("cloud:status", handler);
    return () => ipcRenderer.removeListener("cloud:status", handler);
  },
  setSettingsDirty: (dirty) => ipcRenderer.send("settings:dirty", dirty),
  openProject: () => ipcRenderer.invoke("dialog:openProject"),
  ensureChatsDir: () => ipcRenderer.invoke("app:ensureChatsDir"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  showItem: (path) => ipcRenderer.invoke("shell:showItem", path),
  readTextFile: (opts) => ipcRenderer.invoke("fs:readTextFile", opts),
  pasteClipboard: (cwd) => ipcRenderer.invoke("clipboard:paste", { cwd }),
  writeClipboardText: (text) => ipcRenderer.invoke("clipboard:writeText", { text }),
  composeInEditor: (draft) => ipcRenderer.invoke("editor:compose", draft),
  getPath: (name) => ipcRenderer.invoke("app:getPath", name),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  listFiles: (opts) => ipcRenderer.invoke("fs:listFiles", opts),
  globalConfigPath: () => ipcRenderer.invoke("config:globalPath"),

  // Config
  readConfig: (opts) => ipcRenderer.invoke("config:read", opts),
  writeConfig: (req) => ipcRenderer.invoke("config:write", req),
  projectConfigPath: (cwd) => ipcRenderer.invoke("config:projectPath", cwd),
  readMemory: (opts) => ipcRenderer.invoke("memory:read", opts),
  writeMemory: (req) => ipcRenderer.invoke("memory:write", req),

  // Git
  gitStatus: (cwd) => ipcRenderer.invoke("git:status", cwd),
  gitFileDiff: (opts) => ipcRenderer.invoke("git:fileDiff", opts),
  gitCreateBranch: (req) => ipcRenderer.invoke("git:createBranch", req),
  gitCheckout: (req) => ipcRenderer.invoke("git:checkout", req),
  gitDeleteBranch: (req) => ipcRenderer.invoke("git:deleteBranch", req),
  gitStage: (opts) => ipcRenderer.invoke("git:stage", opts),
  gitUnstage: (opts) => ipcRenderer.invoke("git:unstage", opts),
  gitCommit: (req) => ipcRenderer.invoke("git:commit", req),
  gitMerge: (req) => ipcRenderer.invoke("git:merge", req),
  gitPush: (req) => ipcRenderer.invoke("git:push", req),
  gitPull: (req) => ipcRenderer.invoke("git:pull", req),
  gitFetch: (opts) => ipcRenderer.invoke("git:fetch", opts),
  ghCheckAvailable: () => ipcRenderer.invoke("gh:checkAvailable"),
  ghPrList: (cwd) => ipcRenderer.invoke("gh:prList", cwd),
  ghPrCreate: (req) => ipcRenderer.invoke("gh:prCreate", req),

  getShellInfo: () => ipcRenderer.invoke("app:getShellInfo"),

  terminalOpen: (opts) => ipcRenderer.invoke("terminal:open", opts),
  terminalWrite: (opts) => ipcRenderer.invoke("terminal:write", opts),
  terminalResize: (opts) => ipcRenderer.invoke("terminal:resize", opts),
  onTerminalEvent: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, terminalEvent: TerminalEvent) => cb(terminalEvent);
    ipcRenderer.on("terminal:event", handler);
    return () => ipcRenderer.removeListener("terminal:event", handler);
  },
};

contextBridge.exposeInMainWorld("vibe", api);
