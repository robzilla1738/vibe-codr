/**
 * Wide-terminal layout smoke (sidebar removed).
 * Asserts Tasks / Subagents / session facts stay INLINE in the chat column on
 * a wide terminal — no right session column. Run via `bun run smoke:sidebar`.
 */
import { testRender } from "@opentui/solid";
import type { EngineClient, EngineCommand, UIEvent } from "@vibe/shared";
import { App } from "../src/app.tsx";

const W = 170;
const H = 40;
const queue: UIEvent[] = [];
let wake: (() => void) | null = null;
const push = (e: UIEvent) => {
  queue.push(e);
  wake?.();
  wake = null;
};

let checks = 0;
let fails = 0;
function check(name: string, ok: boolean, detail?: string) {
  checks++;
  if (ok) console.log(`PASS  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const engine: EngineClient = {
  snapshot: () => ({
    sessionId: "side-smoke",
    model: "ollama/gemma4:31b",
    mode: "execute",
    approvalMode: "ask",
    goal: null,
    usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540, costUSD: 0.012 },
    tasks: [],
    theme: "default",
    accentColor: "",
    details: "normal",
    mouse: true,
    commandNames: [],
    git: { branch: "main", dirty: 1, ahead: 0, behind: 0, worktree: false },
  }),
  send: (_cmd: EngineCommand) => {},
  async listModels() {
    return [];
  },
  listProviders() {
    return [];
  },
  listAgents() {
    return [];
  },
  async *events() {
    while (true) {
      if (queue.length) {
        const e = queue.shift();
        if (e) yield e;
        continue;
      }
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  },
};

const t = await testRender(() => <App engine={engine} />, { width: W, height: H });
await t.renderOnce();
const settle = async () => {
  await t.flush();
  await new Promise((r) => setTimeout(r, 60));
  await t.waitForVisualIdle().catch(() => {});
  await t.flush();
};

push({ type: "session-start", sessionId: "side-smoke" } as UIEvent);
push({
  type: "git-updated",
  git: { branch: "main", dirty: 1, ahead: 0, behind: 0, worktree: false },
} as UIEvent);
push({
  type: "user-message",
  sessionId: "side-smoke",
  text: "research the venue capacity",
} as UIEvent);
push({
  type: "tasks-updated",
  sessionId: "side-smoke",
  tasks: [
    { id: "t1", title: "Scout venues", status: "in_progress" },
    { id: "t2", title: "Summarize capacity", status: "pending" },
  ],
} as UIEvent);
push({
  type: "subagent-started",
  sessionId: "side-smoke",
  subagentId: "sa1",
  prompt: "research the venue",
} as UIEvent);
push({
  type: "subagent-activity",
  sessionId: "side-smoke",
  subagentId: "sa1",
  label: "rg capacity",
} as UIEvent);
push({
  type: "tool-call-started",
  sessionId: "side-smoke",
  toolCallId: "g1",
  toolName: "grep",
  input: { pattern: "capacity" },
} as UIEvent);
push({
  type: "tool-call-finished",
  sessionId: "side-smoke",
  toolCallId: "g1",
  toolName: "grep",
  output: "found 3 sites",
  isError: false,
} as UIEvent);
push({
  type: "assistant-text-delta",
  sessionId: "side-smoke",
  delta: "Working the capacity question in-thread.",
} as UIEvent);
await settle();
await settle();

const frame = t.captureCharFrame();
check("wide terminal has NO session card (sidebar removed)", !frame.includes("◆ session"));
check(
  "tasks panel is inline in the chat column",
  frame.includes("Tasks") && frame.includes("Scout venues"),
);
check(
  "subagents panel is inline in the chat column",
  frame.includes("Subagents") && frame.includes("research the venue"),
);
check("subagent live activity shows inline", frame.includes("rg capacity"));
check(
  "transcript still shows tool work",
  frame.includes("capacity") || frame.includes("grep") || frame.includes("#"),
);
check(
  "context line still shows git (not stolen by a session card)",
  frame.includes("on main"),
);
check("status shows the model in the under-input footer", frame.includes("ollama/gemma4:31b"));

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails}/${checks} FAILED`);
process.exit(fails === 0 ? 0 : 1);
