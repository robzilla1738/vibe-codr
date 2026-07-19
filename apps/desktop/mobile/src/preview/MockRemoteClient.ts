// A stand-in RemoteEngineClient for the preview harness. Implements the same
// surface useRemoteSession + the sheets use, returning canned data and replaying
// a short scripted event stream so the UI renders real chrome + transcript state
// with no engine or relay. Shape-compatible with RemoteEngineClient.
import type { EngineCommand } from "@shared/commands";
import type { HostRpcParams, RpcMethod } from "@shared/protocol";
import type { EngineSnapshot } from "@shared/types";
import type { MobileUploadResult, RelayOutbound } from "@relay/protocol";
import type { CloudRelayRequest, CloudRelayResult, GitRelayRequest, GitRelayResult } from "@relay/protocol";
import type { CloudSettingsPublic } from "@shared/cloud";
import type { GitFullStatus } from "@shared/git-types";
import { MOCK_EVENTS, MOCK_PROJECTS, MOCK_SNAPSHOT } from "./mockData";

type EventSink = (event: unknown) => void;
type RelaySink = (frame: RelayOutbound) => void;

export class MockRemoteClient {
  #eventSinks = new Set<EventSink>();
  #relaySinks = new Set<RelaySink>();
  #started = false;
  onFatal: ((message: string) => void) | null = null;
  onReady: ((sessionId: string) => void) | null = null;
  onDisconnect: (() => void) | null = null;

  get isReady(): boolean { return this.#started; }
  get sessionId(): string { return MOCK_SNAPSHOT.sessionId; }

  async connect(): Promise<string> {
    this.#started = true;
    this.onReady?.(MOCK_SNAPSHOT.sessionId);
    // Replay the scripted stream so the transcript shows a turn + tool block.
    let i = 0;
    const tick = () => {
      if (i >= MOCK_EVENTS.length) return;
      const ev = MOCK_EVENTS[i++];
      for (const sink of this.#eventSinks) sink(ev);
      setTimeout(tick, 400);
    };
    setTimeout(tick, 300);
    return MOCK_SNAPSHOT.sessionId;
  }

  async rebootstrap(_opts: { cwd: string; resume?: string; continueLatest?: boolean }): Promise<string> {
    return MOCK_SNAPSHOT.sessionId;
  }

  async snapshot(): Promise<EngineSnapshot> { return MOCK_SNAPSHOT; }

  async rpc(method: RpcMethod, _params?: HostRpcParams): Promise<unknown> {
    switch (method) {
      case "listProjects": return MOCK_PROJECTS;
      case "listModels": return [{ id: "gpt-5.3-codex", providerId: "openai-codex", name: "Codex 5.3", contextWindow: 200000 }];
      case "listProviders": return [{ id: "openai-codex", configured: true, keyless: false, env: [] }];
      case "listAgents": return [];
      case "listSkills": return [];
      case "listMcp": return [];
      case "listPluginStatus": return [];
      default: return null;
    }
  }

  send(_command: EngineCommand): void { /* no-op in preview */ }

  onEvent(handler: EventSink): () => void { this.#eventSinks.add(handler); return () => this.#eventSinks.delete(handler); }
  onRelay(handler: RelaySink): () => void { this.#relaySinks.add(handler); return () => this.#relaySinks.delete(handler); }

  termOpen(_cwd: string, _cols: number, _rows: number): void {
    setTimeout(() => {
      for (const sink of this.#relaySinks) sink({ relay: "term-opened", requestId: "preview-term", result: { ok: true, id: "mock-term", cwd: _cwd, shell: "fish", reused: false, replay: "$ echo hello\r\nhello\r\n$ ", sequence: 2 } } as RelayOutbound);
    }, 100);
  }
  termInput(_id: string, data: string): void {
    setTimeout(() => {
      for (const sink of this.#relaySinks) sink({ relay: "term-event", event: { type: "data", id: _id, data: data + "ok\r\n$ ", sequence: 3 } } as RelayOutbound);
    }, 80);
  }
  termResize(): void {}
  termClose(): void {}
  listFiles(_cwd: string, _query: string, _limit = 40): void {
    setTimeout(() => {
      for (const sink of this.#relaySinks) sink({ relay: "files", requestId: "preview-files", paths: ["package.json", "src/App.tsx", "README.md"] } as RelayOutbound);
    }, 80);
  }

  async uploadFile(input: { cwd: string; name: string; mimeType?: string; dataBase64: string }): Promise<MobileUploadResult> {
    return { ok: true, path: `.vibe/mobile-attachments/preview-${input.name}`, name: input.name, size: Math.floor(input.dataBase64.length * 0.75), ...(input.mimeType ? { mimeType: input.mimeType } : {}) };
  }

  async configRead(scope: string) { return { ok: true, config: { model: "openai-codex/gpt-5.3-codex", mode: "execute", approvalMode: "ask", theme: "default", details: "normal", maxSteps: 75, subagent: { maxDepth: 3, maxParallel: 8 }, compaction: { threshold: 0.75 }, budget: { limitUSD: 5, onExceed: "warn" } }, path: `/preview/${scope}/config.json`, raw: "" }; }
  async configWrite() { return { ok: true, config: {} }; }
  async memoryRead() { return { ok: true, path: "/preview/VIBE.md", content: "# Project instructions\n\nBe concise.", exists: true }; }
  async memoryWrite() { return { ok: true }; }
  async git(request: GitRelayRequest): Promise<GitRelayResult> {
    if (request.action === "ghAvailable") return { ok: true, available: true };
    if (request.action === "prList") return { ok: true, prs: [{ number: 142, title: "Mobile parity and remote workspace", state: "OPEN", head: "codex/mobile-parity", url: "https://github.com/robzilla1738/vbcode-electron/pull/142" }] };
    if (request.action === "prCreate") return { ok: true, url: "https://github.com/robzilla1738/vbcode-electron/pull/143", message: "Pull request created" };
    if (request.action !== "status") return { ok: true, message: "Done" };
    const status: GitFullStatus = {
      branch: "main", upstream: "origin/main", ahead: 2, behind: 0, clean: false,
      stagedCount: 1, unstagedCount: 1, untrackedCount: 1,
      entries: [
        { index: "M", working: " ", path: "mobile/src/components/Composer.tsx" },
        { index: " ", working: "M", path: "relay/server.ts" },
        { index: "?", working: "?", path: "mobile/src/components/GitWorkspace.tsx" },
      ],
      branches: [
        { name: "main", current: true, remote: false, upstream: "origin/main", ahead: 2, behind: 0, lastSubject: "Polish mobile shell", lastDate: Date.now() - 720000 },
        { name: "codex/mobile-parity", current: false, remote: false, lastSubject: "Add remote terminal", lastDate: Date.now() - 3600000 },
        { name: "origin/main", current: false, remote: true, lastSubject: "Release v0.5", lastDate: Date.now() - 86400000 },
      ],
      remotes: [{ name: "origin", url: "git@github.com:robzilla1738/vbcode-electron.git", host: "github.com", owner: "robzilla1738", repo: "vbcode-electron" }],
      recentCommits: [
        { hash: "a1b2c3d4", shortHash: "a1b2c3d", author: "Robert", date: Date.now() - 720000, subject: "Polish mobile shell" },
        { hash: "e5f6a7b8", shortHash: "e5f6a7b", author: "Robert", date: Date.now() - 7200000, subject: "Add remote terminal" },
      ],
    };
    return { ok: true, status };
  }
  async cloud(request: CloudRelayRequest): Promise<CloudRelayResult> {
    const settings: CloudSettingsPublic = {
      experimentalEnabled: true,
      transferModelCredentials: true,
      lastProvider: "e2b",
      autoPauseMinutes: 10,
      deleteOnReturn: true,
      providers: { e2b: { configured: true, account: "preview@example.com" }, vercel: { configured: false } },
      credentialBindings: [], allowedDomains: [], additionalExclusions: [],
    };
    if (request.action === "settings" || request.action === "updateSettings" || request.action === "connect" || request.action === "disconnect" || request.action === "saveBinding" || request.action === "removeBinding") return { ok: true, value: settings };
    if (request.action === "test") return { ok: true, value: { ok: true, account: "preview@example.com" } };
    if (request.action === "listSessions") return { ok: true, value: [] };
    if (request.action === "handoff") return { ok: true, value: { sessionId: MOCK_SNAPSHOT.sessionId, workspaceId: "preview", sourceRoot: request.request.cwd, provider: request.request.provider, sandboxId: "sandbox-preview", sandboxName: "vibe-preview", ownershipGeneration: 1, status: "running", baseFingerprint: "preview", updatedAt: Date.now() } };
    if (request.action === "reconnect") return { ok: true, sessionId: request.sessionId };
    if (request.action === "resumeLocal" || request.action === "recoverLost") return { ok: true, value: { sessionId: request.sessionId, cwd: "/Users/you/Code/vibe-codr/electron", divergent: false } };
    return { ok: true };
  }

  async shutdown(): Promise<void> { this.#started = false; }
}
