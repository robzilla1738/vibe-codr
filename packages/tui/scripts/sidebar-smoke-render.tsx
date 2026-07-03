/**
 * Wide-terminal (180×46) render smoke: drives the REAL App with a mock engine
 * and asserts, against the captured char frames —
 *  • the sidebar trail shows tool ACTIVITY for a non-reasoning model (header
 *    "Activity"), flipping to "Thinking" once reasoning arrives;
 *  • the sidebar's first block starts on the transcript viewport's first
 *    content row and its bottom lands on the input block's bottom row;
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

// ── Scene 1: plan-mode turn on a NON-reasoning model — activity trail + alignment.
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

// Activity trail: header says Activity (no reasoning yet) and shows tool lines.
check("panel header reads Activity for a non-reasoning model", frame1.includes("Activity"));
const sidebarText = rows1.map((r) => r.slice(W - 44)).join("\n");
check("activity trail lists the search", sidebarText.includes("search"), "sidebar shows tool actions");
check("activity trail lists the fetch", sidebarText.includes("fetch"));

// Alignment. TOP: the sidebar's first block must start on the transcript
// viewport's first content row (the row right under the context line) — that
// is where scrolled content paints, which is the state the user sees
// mid-session. BOTTOM: the sidebar's last rail row == the input block's
// bottom rail row (the chat column's last ▎).
const railRows = (lo: number, hi: number): number[] =>
  rows1.flatMap((r, i) => (r.slice(lo, hi).includes("▎") ? [i] : []));
const chat = railRows(0, 60);
const side = railRows(W - 48, W);
const contextRow = rows1.findIndex((r) => r.includes("~/"));
check(
  "sidebar first block starts on the viewport's first content row",
  side[0] === contextRow + 1,
  `context row=${contextRow} side top=${side[0]}`,
);
check(
  "sidebar bottom lands on the input block's bottom row",
  chat[chat.length - 1] === side[side.length - 1],
  `chat bottom=${chat[chat.length - 1]} side bottom=${side[side.length - 1]}`,
);

// ── Scene 2: reasoning arrives — header flips to Thinking, trail interleaves.
push({ type: "reasoning-delta", id: "r1", delta: "Now weighing the layout options.\n" } as UIEvent);
await settle();
const frame2 = t.captureCharFrame();
check("header flips to Thinking once reasoning exists", frame2.includes("Thinking") && !frame2.includes("✻ Activity"));
check("reasoning interleaves after activity", frame2.includes("weighing the layout options"));

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
process.exit(failures === 0 ? 0 : 1);
