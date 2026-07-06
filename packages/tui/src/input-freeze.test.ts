import { expect, test } from "bun:test";
import type { EngineClient, EngineCommand, EngineSnapshot, UIEvent } from "@vibe/shared";

const preloadModule = "@opentui/solid/preload";
await import(preloadModule);

const solidModule = "@opentui/solid";
const { testRender } = await import(solidModule);
const appModule = "./app.tsx";
const { App } = (await import(appModule)) as {
  App: (props: { engine: EngineClient }) => unknown;
};

function makeEngine() {
  const queue: UIEvent[] = [];
  let wake: (() => void) | null = null;
  const sent: EngineCommand[] = [];
  const push = (event: UIEvent) => {
    queue.push(event);
    wake?.();
    wake = null;
  };
  const snapshot = (): EngineSnapshot => ({
    sessionId: "freeze-test",
    model: "ollama/glm-5.2",
    mode: "execute",
    approvalMode: "ask",
    goal: null,
    history: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
    tasks: [],
    busy: false,
    theme: "default",
    accentColor: "",
    commandNames: ["help"],
    git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false },
  });
  const engine: EngineClient = {
    snapshot,
    async listModels() {
      return [];
    },
    send: (cmd) => {
      sent.push(cmd);
    },
    async *events() {
      while (true) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return { engine, push, sent };
}

async function settle(t: { flush: () => Promise<void> }, ms = 80) {
  await t.flush();
  await new Promise((resolve) => setTimeout(resolve, ms));
  await t.flush();
}

test("complete bracketed paste still lands in the prompt textarea", async () => {
  const { engine, sent } = makeEngine();
  const t = await testRender(() => App({ engine }), { width: 90, height: 24 });
  try {
    await t.renderOnce();
    await t.mockInput.pasteBracketedText("pasted text");
    await settle(t);
    t.mockInput.pressEnter();
    await settle(t);
    expect(sent).toContainEqual({ type: "submit-prompt", text: "pasted text" });
  } finally {
    t.renderer.destroy();
  }
});

test("unterminated bracketed paste does not permanently swallow keyboard or mouse input", async () => {
  const { engine, push, sent } = makeEngine();
  const t = await testRender(() => App({ engine }), { width: 90, height: 24 });
  try {
    await t.renderOnce();
    for (let i = 0; i < 16; i++) {
      push({ type: "user-message", sessionId: "freeze-test", text: `turn ${i}` });
      push({
        type: "assistant-text-delta",
        sessionId: "freeze-test",
        delta: `reply ${i}\n\n${"long line ".repeat(30)}`,
      });
      push({ type: "turn-finished", sessionId: "freeze-test" });
    }
    await settle(t, 300);

    const beforeScroll = t.captureCharFrame();
    await t.mockInput.pressKeys(["\x1b[200~"]);
    await settle(t, 1200);
    await t.mockMouse.scroll(40, 8, "up");
    await settle(t);
    expect(t.captureCharFrame()).not.toBe(beforeScroll);

    await t.mockInput.typeText("alive input");
    t.mockInput.pressEnter();
    await settle(t);
    expect(sent).toContainEqual({ type: "submit-prompt", text: "alive input" });
  } finally {
    t.renderer.destroy();
  }
});
