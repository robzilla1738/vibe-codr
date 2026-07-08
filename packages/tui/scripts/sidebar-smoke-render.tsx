/**
 * Wide-terminal (180×46) render smoke: drives the REAL App with a mock engine
 * and asserts, against the captured char frames —
 *  • tool-only turns do NOT put an "Activity" trail in the sidebar (tools
 *    live only in the chat transcript); Thinking appears once reasoning does;
 *  • the sidebar's first block starts on the transcript viewport's first
 *    content row and its bottom lands on the input block's bottom row;
 *  • the sidebar hosts the SUBAGENTS fan-out (prompt + live activity line,
 *    result glimpse on finish), the inline panel stays hidden, and the
 *    bottom alignment still holds with three sidebar blocks stacked;
 *  • transcript render windowing: old turns leave the tree behind a
 *    "▸ N earlier turns" fold row that reveals on tap (scroll-anchored).
 * Run via `bun run smoke:sidebar` (a LOCAL gate, like smoke:tui).
 */
import { testRender } from "@opentui/solid";
import type { EngineClient, EngineCommand, UIEvent } from "@vibe/shared";
import { App } from "../src/app.tsx";

const W = 180;
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
    sessionId: "vf",
    model: "ollama/gemma4:31b",
    mode: "plan",
    approvalMode: "ask",
    goal: null,
    usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540, costUSD: 0.012 },
    tasks: [],
    theme: "default",
    accentColor: "",
    commandNames: ["help"],
    git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false },
  }),
  send: (cmd) => sent.push(cmd),
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

const t = await testRender(() => <App engine={engine} />, { width: W, height: 46 });
await t.renderOnce();
const settle = async () => {
  await t.flush();
  await new Promise((r) => setTimeout(r, 120));
  await t.waitForVisualIdle().catch(() => {});
  await t.flush();
};

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── Scene 1: plan-mode turn on a NON-reasoning model — tools in chat only.
push({ type: "user-message", text: "help me build a world cup site" });
push({
  type: "tasks-updated",
  sessionId: "vf",
  tasks: [
    { id: "t1", title: "Research the match", status: "in_progress" },
    { id: "t2", title: "Scaffold the site", status: "pending" },
  ],
} as UIEvent);
push({
  type: "tool-call-started",
  toolCallId: "c1",
  toolName: "web_search",
  input: { query: "World Cup match yesterday July 2 2026" },
} as UIEvent);
push({ type: "tool-call-finished", toolCallId: "c1", output: "12 results", isError: false } as UIEvent);
push({
  type: "tool-call-started",
  toolCallId: "c2",
  toolName: "webfetch",
  input: { url: "https://www.aljazeera.com/sports/liveblog" },
} as UIEvent);
push({ type: "tool-call-finished", toolCallId: "c2", output: "37 lines", isError: false } as UIEvent);
await settle();
const frame1 = t.captureCharFrame();
const rows1 = frame1.split("\n");

// Contract: no redundant Activity panel. Tools stay in the chat transcript.
const sidebarText = rows1.map((r) => r.slice(W - 44)).join("\n");
const chatText1 = rows1.map((r) => r.slice(0, W - 46)).join("\n");
check("sidebar has no Activity header without reasoning", !sidebarText.includes("Activity"));
check("sidebar has no Thinking panel without reasoning", !sidebarText.includes("Thinking"));
check("sidebar does not list tool search in the trail", !sidebarText.includes("World Cup match"));
check("transcript still shows the search tool row", chatText1.includes("search"));
check("transcript still shows the fetch tool row", chatText1.includes("fetch"));

// Session card — the sidebar masthead: the tiny half-block wordmark (same
// brand family as the splash, scaled down) + bare dir/model/git value lines.
check("session card shows the tiny block wordmark", sidebarText.includes("█▄▄ █▀▀"));
check("session card shows the working dir", sidebarText.includes("~/"));
check("session card shows the model", sidebarText.includes("ollama/gemma4:31b"));
check("session card shows the git branch", sidebarText.includes("on main"));
// The card OWNS these facts while it's up — the chat column must not
// double-print them (top-left context line blank, footer keeps only the
// changed-files delta).
check("chat top-left context line is blank while the card is up", !chatText1.includes("~/"));
check("chat footer drops the model while the card is up", !chatText1.includes("ollama/gemma4:31b"));

// Alignment. TOP: the sidebar's first block must start on the transcript
// viewport's first content row (the row right under the context line) — that
// is where scrolled content paints, which is the state the user sees
// mid-session. BOTTOM: the sidebar's last rail row == the input block's
// bottom rail row (the chat column's last ▎). With no Thinking panel, the
// grow filler + under-input reserve still hold bottom alignment.
const railRows = (lo: number, hi: number): number[] =>
  rows1.flatMap((r, i) => (r.slice(lo, hi).includes("▎") ? [i] : []));
const chat = railRows(0, 60);
const side = railRows(W - 48, W);
// Row 0 = column padding, row 1 = the (now blank, height-pinned) context
// line, row 2 = the viewport's first content row — where the sidebar's first
// block must start. (The context line's text is blank while the session card
// is up, so the row is located by construction, not by finding "~/".)
check(
  "sidebar first block starts on the viewport's first content row",
  side[0] === 2,
  `side top=${side[0]}`,
);
check(
  "sidebar bottom lands on the input block's bottom row",
  chat[chat.length - 1] === side[side.length - 1],
  `chat bottom=${chat[chat.length - 1]} side bottom=${side[side.length - 1]}`,
);

// ── Scene 2: reasoning arrives — Thinking panel appears (still no Activity).
push({ type: "reasoning-delta", id: "r1", delta: "Now weighing the layout options.\n" } as UIEvent);
await settle();
const frame2 = t.captureCharFrame();
const side2 = frame2.split("\n").map((r) => r.slice(W - 44)).join("\n");
check("Thinking panel appears once reasoning exists", side2.includes("Thinking"));
check("sidebar still has no Activity header", !side2.includes("Activity"));
check("reasoning text is in the Thinking panel", side2.includes("weighing the layout options"));

// ── Scene 2b: a subagent fan-out — the sidebar hosts the Subagents panel
// (child + live activity line), the inline chat-column panel stays hidden,
// and the bottom alignment still holds with three sidebar blocks stacked.
push({
  type: "subagent-started",
  sessionId: "vf",
  subagentId: "sub1",
  prompt: "research the venue capacity",
} as UIEvent);
push({
  type: "subagent-activity",
  sessionId: "vf",
  subagentId: "sub1",
  label: "$ rg capacity docs/",
} as UIEvent);
await settle();
const frameSub = t.captureCharFrame();
const rowsSub = frameSub.split("\n");
const sideSlice = rowsSub.map((r) => r.slice(W - 44)).join("\n");
const chatSlice = rowsSub.map((r) => r.slice(0, W - 46)).join("\n");
check("sidebar shows the Subagents panel", sideSlice.includes("Subagents"));
check("subagent row shows its prompt", sideSlice.includes("research the venue"));
check("subagent row shows its LIVE activity line", sideSlice.includes("rg capacity"));
check("inline Subagents panel stays hidden while the sidebar hosts it", !chatSlice.includes("Subagents"));
const railRowsSub = (lo: number, hi: number): number[] =>
  rowsSub.flatMap((r, i) => (r.slice(lo, hi).includes("▎") ? [i] : []));
const chatSub = railRowsSub(0, 60);
const sideSub = railRowsSub(W - 48, W);
check(
  "sidebar bottom still lands on the input's bottom row with Subagents up",
  chatSub[chatSub.length - 1] === sideSub[sideSub.length - 1],
  `chat bottom=${chatSub[chatSub.length - 1]} side bottom=${sideSub[sideSub.length - 1]}`,
);
push({
  type: "subagent-finished",
  sessionId: "vf",
  subagentId: "sub1",
  result: "holds 81,365 — checked two sources",
} as UIEvent);
await settle();
const frameSubDone = t.captureCharFrame();
const sideDone = frameSubDone.split("\n").map((r) => r.slice(W - 44)).join("\n");
check("finished subagent folds in its result glimpse", sideDone.includes("81,365"));

// ── Scene 3: windowing — 45 turns → fold row with the right count.
push({ type: "turn-finished", sessionId: "vf" } as UIEvent);
for (let i = 0; i < 45; i++) {
  push({ type: "user-message", text: `question number ${i}` });
  push({ type: "assistant-text-delta", id: `a${i}`, delta: `answer number ${i}` } as UIEvent);
  push({ type: "turn-finished", sessionId: "vf" } as UIEvent);
}
await settle();
await settle();
let frame3 = t.captureCharFrame();
check("newest turn is rendered", frame3.includes("answer number 44"));
check("windowed-out turn is NOT in the tree", !frame3.includes("question number 2 "));
// The fold row sits at the TOP of the scroll content — scroll the transcript
// up until it is in the viewport (sticky-bottom keeps us pinned low).
for (let i = 0; i < 300 && !frame3.includes("earlier turn"); i++) {
  await t.mockMouse.scroll(60, 10, "up");
  if (i % 25 === 24) {
    await t.flush();
    frame3 = t.captureCharFrame();
  }
}
await settle();
frame3 = t.captureCharFrame();
// 46 total turns, window 40 → 6 folded.
check("fold row shows the folded-turn count", frame3.includes("6 earlier turns"), "expected '▸ 6 earlier turns'");
// Tap it: 6 < REVEAL_PAGE, so everything unfolds and the row disappears.
const foldRowIdx = frame3.split("\n").findIndex((r) => r.includes("earlier turn"));
if (foldRowIdx >= 0) {
  const foldCol = frame3.split("\n")[foldRowIdx]!.indexOf("earlier");
  await t.mockMouse.click(Math.max(2, foldCol), foldRowIdx);
  await settle();
  const frame4 = t.captureCharFrame();
  check("tapping the fold row reveals the older turns", !frame4.includes("earlier turn"));
} else {
  check("tapping the fold row reveals the older turns", false, "fold row never became visible");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
if (failures > 0) {
  console.log("\n--- frame 1 ---\n" + frame1);
  console.log("\n--- frame 3 (tail) ---\n" + frame3.split("\n").slice(0, 14).join("\n"));
}
await t.destroy?.().catch?.(() => {});
process.exit(failures === 0 ? 0 : 1);
