/**
 * Dev smoke test for the OpenTUI app's render + input paths (app.tsx).
 *
 * app.tsx can't run under `bun test` (OpenTUI is an optional native peer dep and
 * needs the Solid JSX transform), so this drives the REAL `App` component with a
 * mock engine via OpenTUI's deterministic test renderer and asserts the things
 * that have actually broken before: the prompt input submits, and the streamed
 * assistant reply renders. Run via `bun run smoke:tui` (entry wires the Solid
 * preload first). Exits non-zero on failure.
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

const t = await testRender(() => <App engine={engine} />, { width: 72, height: 18 });
await t.renderOnce();
const settle = async () => {
  await t.flush();
  await new Promise((r) => setTimeout(r, 20));
  await t.waitForVisualIdle().catch(() => {});
  await t.flush();
};

// 1) Header renders.
let frame = t.captureCharFrame();
check("header shows branding", frame.includes("vibe-codr"));
check("header shows EXECUTE mode", frame.includes("EXECUTE"));
check("header shows model", frame.includes("ollama/glm-5.2"));

// 2) Typing + Enter submits a prompt command (the focus/submit path).
await t.mockInput.typeText("hello there");
await settle();
t.mockInput.pressEnter();
await settle();
check(
  "Enter submits a prompt",
  sent.some((c) => c.type === "submit-prompt" && c.text === "hello there"),
);

// 3) A streamed assistant reply renders (the regression that showed no output).
push({ type: "user-message", text: "What is 6 times 7?" });
push({ type: "assistant-text-delta", id: "d", delta: "The answer is " } as UIEvent);
push({ type: "assistant-text-delta", id: "d", delta: "42." } as UIEvent);
await settle();
frame = t.captureCharFrame();
check("user message renders", frame.includes("What is 6 times 7?"));
check("streamed assistant reply renders", frame.includes("42."));

// 4) A tool call renders.
push({ type: "tool-call-started", toolCallId: "t1", toolName: "read", input: { path: "x" } } as UIEvent);
await settle();
frame = t.captureCharFrame();
check("tool call renders", frame.includes("read"));

// 5) The slash-command menu opens, drills into values, and runs the selection.
sent.length = 0;
await t.mockInput.typeText("/appr");
await settle();
frame = t.captureCharFrame();
check("menu opens on slash", frame.includes("approvals"));
// Enter drills into the value list ("/approvals "), Down highlights "auto",
// Enter runs it. Reaching set-approvals:auto proves the whole drill+select path
// (the value list can't be navigated unless it opened). Frame-text of the value
// rows is asserted by the paletteState unit tests, not the headless capture.
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

if (failures.length) {
  console.error(`\nSMOKE FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nSMOKE OK");
process.exit(0);
