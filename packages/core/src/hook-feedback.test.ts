import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig } from "@vibe/config";
import type { UIEvent } from "@vibe/shared";
import { Engine } from "./engine.ts";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function stream(chunks: unknown[]) {
  return { stream: simulateReadableStream({ chunks: chunks as never[], initialDelayInMs: 0, chunkDelayInMs: 0 }) };
}
const textStep = (text: string) =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]);

/** A text-only model (no mutations → no gate/verify), capturing every prompt it
 * receives so the number of turns the engine drove is observable. */
function textModel() {
  const prompts: string[] = [];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textStep("done") as never;
    },
  });
  return { model, prompts };
}

function mockRegistry(model: MockLanguageModelV2): ProviderRegistry {
  return new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
}

async function makeEngine(
  model: MockLanguageModelV2,
): Promise<{ engine: Engine; events: UIEvent[]; collector: Promise<void> }> {
  const config = defaultConfig();
  config.model = "mock/test";
  // Keep turns minimal: a plain text turn is never gateable, and disabling
  // checkpoints avoids a git snapshot on the throwaway temp dir.
  config.checkpoints.enabled = false;
  const dir = mkdtempSync(join(tmpdir(), "vibe-hookfb-"));
  const engine = new Engine({ config, cwd: dir, registry: mockRegistry(model), interactive: false });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  // Collect until the stream ends (on shutdown) so buffered events — engine-idle
  // and late notices — are all delivered before the test asserts on them.
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  return { engine, events, collector };
}

const idleEvents = (events: UIEvent[]) => events.filter((e) => e.type === "engine-idle");
const warnNotices = (events: UIEvent[]) =>
  events.filter((e): e is Extract<UIEvent, { type: "notice" }> => e.type === "notice" && e.level === "warn");

test("session.idle continue hook forces one follow-up turn then settles idle", async () => {
  const { model, prompts } = textModel();
  const { engine, events, collector } = await makeEngine(model);
  let fired = 0;
  engine.hooks.on("session.idle", (p) => {
    fired += 1;
    // Ask to continue exactly once; the second drain settles idle.
    return fired === 1 ? { ...p, continue: true, reason: "finish the remaining work" } : p;
  });

  engine.send({ type: "submit-prompt", text: "start" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // Initial turn + exactly ONE synthetic continuation.
  expect(prompts).toHaveLength(2);
  // The continuation prompt was built from the hook's `reason`.
  expect(prompts[1]).toContain("finish the remaining work");
  // engine-idle STILL fires (the terminal signal is never skipped).
  expect(idleEvents(events).length).toBeGreaterThanOrEqual(1);
});

test("session.idle continue budget caps an always-continue hook at 3 with a warn notice", async () => {
  const { model, prompts } = textModel();
  const { engine, events, collector } = await makeEngine(model);
  engine.hooks.on("session.idle", (p) => ({ ...p, continue: true, reason: "again" }));

  engine.send({ type: "submit-prompt", text: "start" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // Initial turn + 3 bounded continuations — never more, however insistent the hook.
  expect(prompts).toHaveLength(4);
  // The budget-exhausted warning was surfaced, and idle still settled.
  expect(warnNotices(events).some((n) => n.message.includes("budget"))).toBe(true);
  expect(idleEvents(events).length).toBeGreaterThanOrEqual(1);
});

test("engine-idle still fires with a throwing session.idle hook", async () => {
  const { model, prompts } = textModel();
  const { engine, events, collector } = await makeEngine(model);
  engine.hooks.on("session.idle", () => {
    throw new Error("hook blew up");
  });

  engine.send({ type: "submit-prompt", text: "start" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // A throwing idle hook yields no continue directive → no extra turns, and the
  // HookBus isolation keeps the queue from wedging.
  expect(prompts).toHaveLength(1);
  expect(idleEvents(events).length).toBeGreaterThanOrEqual(1);
});

test("the idle-continue budget resets on each real user prompt", async () => {
  const { model, prompts } = textModel();
  const { engine, events, collector } = await makeEngine(model);
  // Continue once per user prompt (fires on the first drain after each submit).
  const seenThisPrompt = new Set<number>();
  let promptEpoch = 0;
  engine.hooks.on("session.idle", (p) => {
    if (!seenThisPrompt.has(promptEpoch)) {
      seenThisPrompt.add(promptEpoch);
      return { ...p, continue: true, reason: "one more" };
    }
    return p;
  });

  engine.send({ type: "submit-prompt", text: "first" });
  await engine.whenIdle();
  promptEpoch = 1;
  engine.send({ type: "submit-prompt", text: "second" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // Each user prompt drove initial + one continuation = 2 turns; the budget reset
  // between them means the second prompt could continue afresh (not blocked by
  // the first prompt's spent round). 2 prompts × 2 turns = 4.
  expect(prompts).toHaveLength(4);
  expect(idleEvents(events).length).toBeGreaterThanOrEqual(2);
});
