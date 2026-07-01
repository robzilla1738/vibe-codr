/**
 * Visual inspector — renders the App in a few states and prints the char frames so
 * a human can eyeball the redesign (blue wordmark, docked menu, rich reply). Not a
 * test; run via `bun packages/tui/scripts/inspect-render.tsx`.
 */
import { testRender } from "@opentui/solid";
import type { EngineClient, EngineCommand, UIEvent } from "@vibe/shared";
import { App } from "../src/app.tsx";

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
    sessionId: "ins",
    model: "openai/gpt-4o",
    mode: "execute",
    approvalMode: "ask",
    goal: null,
    usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540, costUSD: 0.012 },
    tasks: [],
    theme: "default",
    accentColor: "",
    commandNames: ["help", "cost", "model", "theme", "approvals"],
    git: { branch: "main", dirty: 2, ahead: 0, behind: 0, worktree: false },
  }),
  send: (cmd) => sent.push(cmd),
  async listModels() {
    return [
      { id: "gpt-4o", providerId: "openai", name: "GPT-4o", contextWindow: 128000 },
      { id: "o4-mini", providerId: "openai", contextWindow: 200000 },
      { id: "glm-5.2", providerId: "ollama", contextWindow: 128000 },
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

const t = await testRender(() => <App engine={engine} />, { width: 96, height: 40 });
await t.renderOnce();
const settle = async () => {
  await t.flush();
  await new Promise((r) => setTimeout(r, 60));
  await t.waitForVisualIdle().catch(() => {});
  await t.flush();
};
const waitForText = async (needle: string, ms = 2000) => {
  const deadline = Date.now() + ms;
  let f = t.captureCharFrame();
  while (!f.includes(needle) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    await t.flush();
    f = t.captureCharFrame();
  }
  return f;
};
const banner = (s: string) => console.log(`\n\n${"═".repeat(96)}\n  ${s}\n${"═".repeat(96)}`);

banner("1) EMPTY-STATE SPLASH (blue wordmark)");
await settle();
console.log(t.captureCharFrame());

banner("2) A RICH REPLY (heading · quote · code · table)");
push({ type: "user-message", text: "create a table of eth vs btc pros and cons" });
push({
  type: "assistant-text-delta",
  id: "r",
  delta:
    "## ETH vs BTC\n\nHere's the rundown.\n\n> **Rule of thumb:** pick the smallest thing that fits your use case.\n\n```ts\nconst store = create((set) => ({ n: 0 }));\n```\n\n| | **Bitcoin (BTC)** | **Ethereum (ETH)** |\n| :-- | :-- | :-- |\n| **Purpose** | Digital store of value / \"digital gold\" | Programmable smart-contract platform |\n| **Consensus** | Proof of Work (SHA-256) | Proof of Stake (Casper, since the Merge) |\n| **Supply** | Hard cap 21M coins | No hard cap; ~0.5% net annual issuance |\n| **Smart contracts** | Very limited (Taproot scripts) | First-class; EVM is the dominant VM |\n\nThat's the shape of it.",
} as UIEvent);
push({ type: "turn-finished", sessionId: "ins" } as UIEvent);
await waitForText("shape of it");
console.log(t.captureCharFrame());

banner("3) SLASH MENU DOCKED TO THE INPUT");
await t.mockInput.typeText("/the");
await settle();
console.log(t.captureCharFrame());

banner("4) MODEL PICKER DOCKED");
t.mockInput.pressEscape();
await settle();
await t.mockInput.typeText("/model ");
await settle();
console.log(t.captureCharFrame());

process.exit(0);
