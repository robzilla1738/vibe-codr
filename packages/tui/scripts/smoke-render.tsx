/**
 * Dev smoke test for the OpenTUI app's render + input paths (app.tsx).
 *
 * app.tsx can't run under `bun test` (OpenTUI is an optional native peer dep and
 * needs the Solid JSX transform), so this drives the REAL `App` component with a
 * mock engine via OpenTUI's deterministic test renderer and asserts the things
 * that have actually broken before: the prompt input submits, the streamed
 * assistant reply renders (via the native <markdown> renderable), tool output is
 * condensed and expands on click, and the context rail shows tasks/subagents.
 * Run via `bun run smoke:tui`. Exits non-zero on failure.
 */
import { testRender } from "@opentui/solid";
import type { EngineClient, EngineCommand, UIEvent } from "@vibe/shared";
import { App } from "../src/app.tsx";

const failures: string[] = [];
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures.push(name);
};

// Controllable mock engine: a push-driven event stream + recorded commands.
const queue: UIEvent[] = [];
let wake: (() => void) | null = null;
const push = (e: UIEvent) => {
  queue.push(e);
  wake?.();
  wake = null;
};
const sent: EngineCommand[] = [];

const engine: EngineClient = {
  snapshot: () => ({
    sessionId: "smoke",
    model: "ollama/glm-5.2",
    mode: "execute",
    approvalMode: "ask",
    goal: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
    tasks: [],
    theme: "default",
  }),
  send: (cmd) => {
    sent.push(cmd);
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

// Wide enough (≥80 cols) that the context rail renders alongside the transcript.
const t = await testRender(() => <App engine={engine} />, { width: 104, height: 30 });
await t.renderOnce();
const settle = async () => {
  await t.flush();
  await new Promise((r) => setTimeout(r, 25));
  await t.waitForVisualIdle().catch(() => {});
  await t.flush();
};

// 1) Header renders.
let frame = t.captureCharFrame();
check("header shows branding", frame.includes("vibe-codr"));
check("header shows EXECUTE mode", frame.includes("EXECUTE"));
check("header/rail shows model", frame.includes("ollama/glm-5.2"));

// 2) Typing + Enter submits a prompt command (the focus/submit path).
await t.mockInput.typeText("hello there");
await settle();
t.mockInput.pressEnter();
await settle();
check(
  "Enter submits a prompt",
  sent.some((c) => c.type === "submit-prompt" && c.text === "hello there"),
);

// 3) A streamed assistant reply renders through the markdown renderable.
push({ type: "user-message", text: "What is 6 times 7?" });
push({ type: "assistant-text-delta", id: "d", delta: "The answer is " } as UIEvent);
push({ type: "assistant-text-delta", id: "d", delta: "**42**." } as UIEvent);
await settle();
frame = t.captureCharFrame();
check("user message renders", frame.includes("What is 6 times 7?"));
check("streamed assistant reply renders", frame.includes("42"));
// A turn is in flight (no turn-finished yet) → the working spinner shows.
check("working indicator renders while a turn runs", frame.includes("Working"));

// 4) A tool call renders with its icon + summary, and its output is condensed.
push({ type: "tool-call-started", toolCallId: "t1", toolName: "read", input: { path: "x" } } as UIEvent);
await settle();
frame = t.captureCharFrame();
check("tool call renders with icon + summary", frame.includes("→ read x"));
push({
  type: "tool-call-finished",
  toolCallId: "t1",
  toolName: "read",
  output: "ALPHA_BODY\nBETA_BODY\nGAMMA_BODY",
  isError: false,
} as UIEvent);
await settle();
frame = t.captureCharFrame();
check("tool output is condensed by default", frame.includes("lines") && !frame.includes("ALPHA_BODY"));

// 5) Clicking the tool row expands its output (click-to-expand). Target the
// TRANSCRIPT tool row specifically (it carries the "▸ … N lines" collapse hint);
// the rail's live Activity feed also shows "read x" but without that hint.
const rowOf = (needle: string) =>
  t.captureCharFrame().split("\n").findIndex((l) => l.includes(needle));
const toolRow = t
  .captureCharFrame()
  .split("\n")
  .findIndex((l) => l.includes("read x") && l.includes("line"));
check("located the tool row to click", toolRow >= 0);
if (toolRow >= 0) {
  await t.mockMouse.click(5, toolRow);
  await settle();
  frame = t.captureCharFrame();
  check("clicking a tool row expands its output", frame.includes("ALPHA_BODY"));
}

// 5b) A file edit folds its diff into ONE row, attributed by tool call id, and
// the diff is shown expanded by default (no click needed). The edit also echoes
// the diff back as its tool-result; that echo must be suppressed so it doesn't
// clobber the rendered hunk. The echo text is deliberately disjoint from the
// diff content so the assertions actually catch a suppression regression.
push({ type: "tool-call-started", toolCallId: "t2", toolName: "edit", input: { path: "g.ts" } } as UIEvent);
push({
  type: "file-changed",
  sessionId: "smoke",
  toolCallId: "t2",
  path: "g.ts",
  action: "edit",
  diff: " ctx unchanged\n-OLD_LINE\n+NEW_LINE",
  added: 1,
  removed: 1,
} as UIEvent);
push({ type: "tool-call-finished", toolCallId: "t2", toolName: "edit", output: "ECHO_SHOULD_BE_HIDDEN", isError: false } as UIEvent);
await settle();
frame = t.captureCharFrame();
check("file edit folds into one diff row", frame.includes("edited g.ts"));
check("diff is expanded by default", frame.includes("NEW_LINE") && frame.includes("OLD_LINE"));
check(
  "the edit's tool-result echo is suppressed (diff not clobbered)",
  !frame.includes("ECHO_SHOULD_BE_HIDDEN"),
);

// 5c) Subagent assistant text must NOT leak into the parent transcript.
push({ type: "assistant-text-delta", sessionId: "smoke", subagentId: "sa_x", delta: "SUBAGENT_LEAK" } as UIEvent);
await settle();
frame = t.captureCharFrame();
check("subagent text does not leak into the transcript", !frame.includes("SUBAGENT_LEAK"));

// 6) The context rail shows the task list and live subagents.
push({
  type: "tasks-updated",
  tasks: [
    { id: "k1", title: "Wire the catalog pricing", status: "completed" },
    { id: "k2", title: "Render the cost footer", status: "in_progress" },
  ],
} as UIEvent);
push({ type: "subagent-started", subagentId: "sa_42", prompt: "explore the repo" } as UIEvent);
await settle();
frame = t.captureCharFrame();
check("rail shows the Tasks section", frame.includes("Tasks"));
check("rail shows a task title", frame.includes("cost footer"));
check("rail shows the Subagents section", frame.includes("Subagents"));
check("rail shows a running subagent", frame.includes("explore the repo"));
// The edit in 5b touched g.ts → it appears in the rail's Changed-files section.
check("rail shows the Changed-files section", frame.includes("Changed"));
// While the turn runs, the rail's live Activity feed surfaces tool calls.
check("rail shows the live Activity feed", frame.includes("Activity"));

// 6b) Context-window fill + token usage/cost surface in the footer once known.
push({ type: "usage-updated", usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, costUSD: 0.0123 } } as UIEvent);
push({ type: "context-updated", usedTokens: 24000, contextWindow: 200000 } as UIEvent);
await settle();
frame = t.captureCharFrame();
check("footer shows context-window fill", frame.includes("ctx 12%"));
check("footer shows token usage + cost", frame.includes("tok") && frame.includes("$0.0123"));

// The turn ends → the working spinner clears.
push({ type: "turn-finished", sessionId: "smoke" } as UIEvent);
await settle();
frame = t.captureCharFrame();
check("working indicator clears when the turn finishes", !frame.includes("Working"));
// Idle now: the Activity feed hides (no transcript duplication) and the rail's
// Session block — model/ctx/cost/goal — is visible.
check("rail Activity hides when idle", !frame.includes("Activity"));
check("rail shows the Session block when idle", frame.includes("Session"));

// 6c) Clicking an assistant message folds its turn's tool work away (just the
// prose remains), and clicking again unfolds it. The "What is 6 times 7?" turn
// owns the read/edit tool rows above.
const msgRow = t
  .captureCharFrame()
  .split("\n")
  .findIndex((l) => l.includes("42"));
if (msgRow >= 0) {
  await t.mockMouse.click(5, msgRow);
  await settle();
  frame = t.captureCharFrame();
  check("clicking a message folds its tool work", frame.includes("hidden") && !frame.includes("edited g.ts"));
  await t.mockMouse.click(5, msgRow);
  await settle();
  frame = t.captureCharFrame();
  check("clicking again unfolds the message", frame.includes("edited g.ts"));
}

// 7) The slash-command menu opens, drills into values, and runs the selection.
sent.length = 0;
await t.mockInput.typeText("/appr");
await settle();
frame = t.captureCharFrame();
check("menu opens on slash", frame.includes("approvals"));
t.mockInput.pressEnter();
await settle();
t.mockInput.pressArrow("down");
await settle();
t.mockInput.pressEnter();
await settle();
check(
  "menu drills into values and runs the selection",
  sent.some((c) => c.type === "set-approvals" && c.mode === "auto"),
);

// 8) A permission request renders as a card and a typed y/a/n answers it.
sent.length = 0;
push({
  type: "permission-request",
  id: "perm1",
  toolName: "bash",
  input: { command: "rm -rf build" },
} as UIEvent);
await settle();
frame = t.captureCharFrame();
check("permission request renders as a card", frame.includes("[y]es once"));
check("permission card identifies the tool", frame.includes("bash"));
await t.mockInput.typeText("y");
await settle();
t.mockInput.pressEnter();
await settle();
check(
  "answering the permission resolves it (allow once)",
  sent.some((c) => c.type === "resolve-permission" && c.decision === "once"),
);

if (failures.length) {
  console.error(`\nSMOKE FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nSMOKE OK");
process.exit(0);
