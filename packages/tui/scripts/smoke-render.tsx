/**
 * Dev smoke test for the OpenTUI app's render + input paths (app.tsx).
 *
 * app.tsx can't run under `bun test` (OpenTUI is an optional native peer dep and
 * needs the Solid JSX transform), so this drives the REAL `App` component with a
 * mock engine via OpenTUI's deterministic test renderer and asserts the things
 * that have actually broken before: the prompt input submits, the streamed
 * assistant reply renders (via the native <markdown> renderable), tool output is
 * condensed and expands on click, and the status panels show tasks/subagents.
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
    accentColor: "#bb9af7",
    commandNames: ["help", "cost", "model", "myskill"],
    git: { branch: "main", dirty: 3, ahead: 1, behind: 0, worktree: false },
  }),
  send: (cmd) => {
    sent.push(cmd);
  },
  // The interactive `/model` picker fetches this list and renders it searchable.
  async listModels() {
    return [
      { id: "glm-5.2", providerId: "ollama", contextWindow: 128000 },
      { id: "gpt-4o", providerId: "openai", name: "GPT-4o", contextWindow: 128000 },
      { id: "o4-mini", providerId: "openai", contextWindow: 200000 },
    ];
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

// A comfortably wide + tall terminal; the chat column centers within it (no
// sidebar), and the short test transcript fits without scrolling the top away.
const t = await testRender(() => <App engine={engine} />, { width: 104, height: 40 });
await t.renderOnce();
const settle = async () => {
  await t.flush();
  // > the streamed-delta coalescing window (STREAM_FLUSH_MS=40ms in app.tsx).
  await new Promise((r) => setTimeout(r, 60));
  await t.waitForVisualIdle().catch(() => {});
  await t.flush();
};
// Poll until `needle` appears (or timeout) — for content rendered by the async
// <markdown> worker, which waitForVisualIdle doesn't wait on (it's off-thread).
const waitForText = async (needle: string, ms = 2000): Promise<string> => {
  const deadline = Date.now() + ms;
  let frame = t.captureCharFrame();
  while (!frame.includes(needle) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    await t.flush();
    frame = t.captureCharFrame();
  }
  return frame;
};

// 1) Fresh screen: the centered VIBE CODR wordmark, the mode break on the input
// border, the model in the under-input status line, and the input placeholder.
let frame = t.captureCharFrame();
// Splash: the block wordmark (░██ cells) + the single "Try ›" prompt-starter line
// (no tagline, no key cheatsheet — those moved to the under-input status).
check("splash renders (wordmark + try line)", frame.includes("░") && frame.includes("explain this codebase"));
check("input shows the placeholder", frame.includes("Send a message"));
check("input border shows the ASK mode", frame.includes("ASK"));
check("status line shows model", frame.includes("ollama/glm-5.2"));

// The wordmark must be an actual rainbow GRADIENT (many distinct per-column
// colors), not a flat fill. captureCharFrame is color-blind, so inspect the
// per-span fg via captureSpans. This guards the regression where inline <span>
// fg didn't paint and the whole wordmark rendered white.
const wordmarkColors = new Set<string>();
for (const line of t.captureSpans().lines) {
  if (!line.spans.some((s) => s.text.includes("░") || s.text.includes("█"))) continue;
  for (const s of line.spans) {
    if (s.text.trim()) wordmarkColors.add(`${s.fg.r},${s.fg.g},${s.fg.b}`);
  }
}
check(`wordmark is a rainbow gradient (${wordmarkColors.size} distinct colors)`, wordmarkColors.size >= 8);
// The default theme paints a BLACK background — guards the regression where a
// persisted `theme: light` (or a non-black default) turned the whole UI white.
const bgBlack = t
  .captureSpans()
  .lines.some((l) =>
    l.spans.some((s) => s.text.includes("░") && s.bg.r < 0.1 && s.bg.g < 0.1 && s.bg.b < 0.1),
  );
check("default theme background is black", bgBlack);

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
frame = await waitForText("42"); // markdown is parsed off-thread; poll for it
check("user message renders", frame.includes("What is 6 times 7?"));
check("streamed assistant reply renders", frame.includes("42"));
// The reply was `**42**.` — the markdown renderable must CONCEAL the bold
// markers (it needs the web-tree-sitter peer dep loaded). Raw `**` leaking
// through means the inline parser didn't load. Guards that regression.
check("assistant bold markers are concealed (no raw **)", !frame.includes("**"));
// A turn is in flight (no turn-finished yet) → the working spinner shows.
check("working indicator renders while a turn runs", frame.includes("Working"));
// The spinner glyph cycles through the rainbow — assert the braille glyph span
// carries a SATURATED fg (channel spread), not the muted/white default. Same
// per-<text fg> mechanism the subagent/tool-step rainbows use.
const saturated = (fg: { r: number; g: number; b: number }) =>
  Math.max(fg.r, fg.g, fg.b) - Math.min(fg.r, fg.g, fg.b) > 0.2;
const spinnerColored = t
  .captureSpans()
  .lines.some((l) => l.spans.some((s) => /[⠀-⣿]/.test(s.text) && saturated(s.fg)));
check("working spinner glyph is rainbow-colored", spinnerColored);

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
// TRANSCRIPT tool row specifically (it carries the "▸ … N lines" collapse hint).
const rowOf = (needle: string) =>
  t.captureCharFrame().split("\n").findIndex((l) => l.includes(needle));
const toolRow = t
  .captureCharFrame()
  .split("\n")
  .findIndex((l) => l.includes("read x") && l.includes("line"));
check("located the tool row to click", toolRow >= 0);
if (toolRow >= 0) {
  // Click inside the centered column (past the left gutter), anywhere on the row.
  await t.mockMouse.click(12, toolRow);
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

// 6) The status panels show the task list and live subagents.
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
check("tasks panel shows the Tasks section", frame.includes("Tasks"));
check("tasks panel shows a task title", frame.includes("cost footer"));
check("subagents panel shows the Subagents section", frame.includes("Subagents"));
check("subagents panel shows a running subagent", frame.includes("explore the repo"));
// The edit in 5b touched g.ts → it shows in the under-input changed-file summary.
check("status line shows the changed-file summary", frame.includes("1 file"));
// The under-input status line surfaces the git branch from the snapshot.
check("status line shows the git branch", frame.includes("main"));

// 6b) Context-window fill + token usage/cost surface under the input once known.
push({ type: "usage-updated", usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, costUSD: 0.0123 } } as UIEvent);
push({ type: "context-updated", usedTokens: 24000, contextWindow: 200000 } as UIEvent);
await settle();
frame = t.captureCharFrame();
check("status line shows context-window fill", frame.includes("ctx 12%"));
check("status line shows token usage + cost", frame.includes("tok") && frame.includes("$0.0123"));

// The turn ends → the working spinner clears.
push({ type: "turn-finished", sessionId: "smoke" } as UIEvent);
await settle();
frame = t.captureCharFrame();
check("working indicator clears when the turn finishes", !frame.includes("Working"));
// Idle: the under-input status line still carries the session model.
check("status line shows the model when idle", frame.includes("ollama/glm-5.2"));

// 6c) Tapping YOUR message folds the whole turn under it (reply + tool work),
// leaving just your message + an expand affordance; tap again to reopen.
const findUserRow = () =>
  t.captureCharFrame().split("\n").findIndex((l) => l.includes("6 times 7"));
let msgRow = findUserRow();
check("located the user message row", msgRow >= 0);
if (msgRow >= 0) {
  await t.mockMouse.click(12, msgRow);
  await settle();
  frame = t.captureCharFrame();
  check(
    "tapping my message folds the whole turn",
    frame.includes("hidden") && !frame.includes("edited g.ts") && !frame.includes("answer is"),
  );
  msgRow = findUserRow();
  if (msgRow >= 0) await t.mockMouse.click(12, msgRow);
  await settle();
  frame = t.captureCharFrame();
  check("tapping again unfolds the turn", frame.includes("edited g.ts"));
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

// 7b) An enum submenu marks the CURRENT value with ● (snapshot theme = default).
await t.mockInput.typeText("/theme ");
await settle();
frame = t.captureCharFrame();
check("value submenu lists the options", frame.includes("opencode") && frame.includes("contrast"));
check("value submenu marks the current value (●)", frame.includes("●"));
// Esc clears the draft (closes the menu) before the next section.
t.mockInput.pressEscape();
await settle();

// 7c) The interactive `/model` picker: fetches the model list, filters as you
// type, marks the current model, and a click dispatches the typed set-model.
sent.length = 0;
await t.mockInput.typeText("/model ");
await settle();
await settle(); // let listModels() resolve and the picker repopulate
frame = t.captureCharFrame();
check("model picker lists provider models", frame.includes("openai/gpt-4o"));
check(
  "model picker marks the current model (●)",
  frame.includes("●") && frame.includes("ollama/glm-5.2"),
);
// Filter to a single openai model by typing — the picker narrows live.
await t.mockInput.typeText("o4-mini");
await settle();
frame = t.captureCharFrame();
// gpt-4o only appears in the picker (glm-5.2 also shows in the footer status
// line, so its absence can't prove filtering — gpt-4o's can).
check(
  "model picker filters as you type",
  frame.includes("openai/o4-mini") && !frame.includes("openai/gpt-4o"),
);
const pickRow = t.captureCharFrame().split("\n").findIndex((l) => l.includes("openai/o4-mini"));
check("located the model picker row", pickRow >= 0);
if (pickRow >= 0) {
  await t.mockMouse.click(12, pickRow);
  await settle();
  check(
    "clicking a model sets it (typed set-model command)",
    sent.some((c) => c.type === "set-model" && c.model === "openai/o4-mini"),
  );
}

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

// 8b) A presented plan renders an interactive approval card; typing revises it.
sent.length = 0;
push({
  type: "plan-presented",
  sessionId: "smoke",
  plan: "## Plan\n- [ ] Step one\n- [ ] Step two",
} as UIEvent);
await settle();
frame = t.captureCharFrame();
check("plan approval card renders with interactive hints", frame.includes("type changes to revise"));
await t.mockInput.typeText("also handle errors");
await settle();
t.mockInput.pressEnter();
await settle();
check(
  "typing while the plan card is up revises the plan (resolve-plan edit)",
  sent.some((c) => c.type === "resolve-plan" && c.decision === "edit"),
);
// Empty Enter on a fresh plan card accepts & executes it.
sent.length = 0;
push({ type: "plan-presented", sessionId: "smoke", plan: "## Plan\n- [ ] One" } as UIEvent);
await settle();
t.mockInput.pressEnter();
await settle();
check(
  "empty Enter on the plan card accepts it (resolve-plan accept)",
  sent.some((c) => c.type === "resolve-plan" && c.decision === "accept"),
);

// 9) Background-jobs sub-view: a running job + its detected localhost server show
// up, and `/jobs` (typed + Enter via the command menu) opens the view.
push({
  type: "jobs-changed",
  sessionId: "smoke",
  jobs: [
    {
      id: "job_1",
      command: "bun run dev",
      status: "running",
      exitCode: null,
      pid: 4242,
      servers: ["http://localhost:5173"],
      outputTail: "VITE ready\n  ➜  Local: http://localhost:5173/",
    },
  ],
} as UIEvent);
await settle();
await t.mockInput.typeText("/jobs");
await settle();
t.mockInput.pressEnter();
await settle();
frame = t.captureCharFrame();
check("/jobs opens the background-jobs view", frame.includes("Background jobs"));
check("jobs view shows the running command", frame.includes("bun run dev"));
check("jobs view surfaces the localhost server", frame.includes("http://localhost:5173"));

// 10) The queue panel shows prompts typed ahead, and `steer`/`✕` send the right
// commands (run-now-with-interrupt / drop). First close the /jobs view.
push({ type: "jobs-changed", sessionId: "smoke", jobs: [] } as UIEvent);
push({
  type: "queue-changed",
  active: { id: "qa", label: "current turn" },
  pending: [
    { id: "q1", label: "add a dark mode toggle" },
    { id: "q2", label: "write tests for the parser" },
  ],
} as UIEvent);
await settle();
frame = t.captureCharFrame();
check("queue panel shows queued prompts", frame.includes("Queued") && frame.includes("add a dark mode toggle"));
sent.length = 0;
const qRow = t.captureCharFrame().split("\n").findIndex((l) => l.includes("dark mode toggle"));
check("located the queued row", qRow >= 0);
if (qRow >= 0) {
  const steerCol = t.captureCharFrame().split("\n")[qRow].indexOf("steer");
  await t.mockMouse.click(steerCol + 2, qRow);
  await settle();
  check(
    "clicking steer runs that queued prompt now (steer command)",
    sent.some((c) => c.type === "steer" && c.id === "q1"),
  );
}

// 11) A reply mixing prose + a code block + a table must render ALL of it. This
// guards the regression where OpenTUI's <markdown> blanked prose siblings of a
// code/table block — vibe now renders code/tables as native primitives, so the
// prose survives. (New turn at the end so it doesn't disturb the turns above.)
t.mockInput.pressEscape(); // close the /jobs sub-view from §9 so the transcript shows
await settle();
push({ type: "queue-changed", active: null, pending: [] } as UIEvent);
push({ type: "user-message", text: "show me a table and code" });
push({
  type: "assistant-text-delta",
  id: "r",
  delta:
    "PROSE_ALPHA before.\n\n```ts\nconst RICHCODE = 1;\n```\n\n| Name | Size |\n| --- | --- |\n| Zustand | tiny |\n\nPROSE_OMEGA after.",
} as UIEvent);
push({ type: "turn-finished", sessionId: "smoke" } as UIEvent);
await settle();
frame = await waitForText("PROSE_OMEGA");
check("rich reply: prose before a code/table block renders", frame.includes("PROSE_ALPHA"));
check("rich reply: prose after a code/table block renders", frame.includes("PROSE_OMEGA"));
check("rich reply: the code block renders", frame.includes("RICHCODE"));
check("rich reply: the table renders (native box-drawing)", frame.includes("Zustand") && frame.includes("│"));

if (failures.length) {
  console.error(`\nSMOKE FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nSMOKE OK");
process.exit(0);
