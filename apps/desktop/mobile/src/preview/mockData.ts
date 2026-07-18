// Canned data for the UI preview harness (no engine/relay needed). Mirrors the
// shapes the shared reducers/guards produce so the preview renders real chrome
// + transcript state. Lets the native UI be exercised/screenshotted standalone.
import type { EngineSnapshot } from "@shared/types";
import type { ProjectSummary } from "@shared/protocol";

export const MOCK_SNAPSHOT: EngineSnapshot = {
  sessionId: "preview-session",
  model: "openai-codex/gpt-5.3-codex",
  mode: "execute",
  goal: "Ship the mobile app to 1:1 parity",
  history: [],
  tasks: [
    { id: "t1", title: "Scaffold Expo app", status: "completed" },
    { id: "t2", title: "Port transcript + composer", status: "completed" },
    { id: "t3", title: "Remote terminal", status: "in_progress" },
    { id: "t4", title: "Screenshot harness", status: "pending" },
  ],
  usage: { inputTokens: 124530, outputTokens: 88421, totalTokens: 212951, costUSD: 0.4231 },
  busy: false,
  theme: "default",
  accentColor: "",
  details: "normal",
  mouse: false,
  approvalMode: "ask",
  commandNames: ["model", "clear", "compact", "theme", "accent", "density", "agents", "skills", "providers", "mcp", "goal", "plan", "execute"],
  git: { branch: "main", dirty: 3, ahead: 2, behind: 0, worktree: false },
};

export const MOCK_PROJECTS: ProjectSummary[] = [
  {
    cwd: "/Users/you/Code/vibe-codr/electron",
    name: "vbcode-electron",
    updatedAt: Date.now() - 1000 * 60 * 12,
    sessions: [
      { id: "preview-session", title: "Mobile parity", model: "gpt-5.3-codex", mode: "execute", goal: "Ship the mobile app", createdAt: Date.now() - 86400000, updatedAt: Date.now() - 1200000 },
      { id: "s2", title: "Diff review polish", model: "gpt-5.3-codex", mode: "plan", goal: null, createdAt: Date.now() - 2 * 86400000, updatedAt: Date.now() - 3 * 3600000 },
    ],
  },
  {
    cwd: "/Users/you/Code/vibe-codr",
    name: "vibe-codr",
    updatedAt: Date.now() - 1000 * 60 * 60 * 5,
    sessions: [{ id: "s3", title: "Engine host protocol", model: "claude-sonnet", mode: "execute", goal: null, createdAt: Date.now() - 3 * 86400000, updatedAt: Date.now() - 5 * 3600000 }],
  },
];

// A short scripted event stream so the preview shows streaming + a tool block.
export const MOCK_EVENTS: unknown[] = [
  { type: "user-message", sessionId: "preview-session", text: "Add a remote terminal to the mobile app" },
  { type: "assistant-text-delta", sessionId: "preview-session", delta: "I'll extend the relay with a terminal channel and build a native terminal panel." },
  { type: "tool-call-started", sessionId: "preview-session", toolCallId: "tc1", toolName: "read", input: { path: "relay/server.ts" } },
  { type: "tool-call-finished", sessionId: "preview-session", toolCallId: "tc1", toolName: "read", output: "228 lines", isError: false },
  { type: "assistant-text-delta", sessionId: "preview-session", delta: " The terminal reuses the desktop TerminalManager over a relay-namespaced channel." },
  { type: "turn-finished", sessionId: "preview-session" },
  { type: "engine-idle", sessionId: "preview-session" },
];
