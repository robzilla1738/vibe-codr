import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig } from "@vibe/config";
import type { UIEvent } from "@vibe/shared";
import { Engine } from "./engine.ts";

function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({
      chunks: chunks as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}
const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function mockRegistry(model: MockLanguageModelV2): ProviderRegistry {
  return new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
}

// A real end-to-end pass through the top-level Engine: submit a prompt, let the
// (mock) model call the REAL `read` builtin against a real file, feed the result
// back, and produce final text — the exact path `vibecodr -p "..."` drives, but
// deterministic so it needs no API key.
test("Engine: prompt -> real read builtin -> tool result -> final text", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-e2e-"));
  writeFileSync(join(cwd, "secret.txt"), "the answer is 42\n");

  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read",
        input: JSON.stringify({ path: "secret.txt" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "The file says the answer is 42." },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });

  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test" },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();

  const events: UIEvent[] = [];
  const sub = engine.events();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  engine.send({ type: "submit-prompt", text: "what is in secret.txt?" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // Both model turns ran (tool-call turn, then final-text turn).
  expect(call).toBe(2);

  // The REAL read tool ran and returned the file's contents.
  const toolDone = events.find((e) => e.type === "tool-call-finished");
  expect(toolDone && toolDone.type === "tool-call-finished" && toolDone.toolName).toBe("read");
  expect(
    toolDone && toolDone.type === "tool-call-finished" && String(toolDone.output),
  ).toContain("the answer is 42");

  // The streamed final answer is correct and the turn completed.
  const text = events
    .filter((e): e is Extract<UIEvent, { type: "assistant-text-delta" }> => e.type === "assistant-text-delta")
    .map((e) => e.delta)
    .join("");
  expect(text).toBe("The file says the answer is 42.");
  expect(events.some((e) => e.type === "turn-finished")).toBe(true);
});

test("Engine planning: present_plan persists the plan + plan→execute injects a handoff", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-plan-"));
  const prompts: string[] = [];
  const steps = [
    // Plan turn: the model presents a plan.
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "p1",
        toolName: "present_plan",
        input: JSON.stringify({ plan: "1. Refactor the loader\n2. Add tests" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Plan presented." },
      { type: "text-end", id: "a" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
    // Execute turn (after approval): capture the prompt the model receives.
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "b", delta: "Implementing the plan." },
      { type: "text-end", id: "b" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return steps[call++] as never;
    },
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", mode: "plan" },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const sub = engine.events();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  engine.send({ type: "submit-prompt", text: "plan a refactor" });
  await engine.whenIdle();
  // The plan was presented and persisted to .vibe/plans/<session>.md.
  expect(events.some((e) => e.type === "plan-presented")).toBe(true);
  const sessionId = engine.snapshot().sessionId;
  const planFile = await Bun.file(join(cwd, ".vibe", "plans", `${sessionId}.md`)).text();
  expect(planFile).toContain("Refactor the loader");

  // Approve: switch to execute, then run a turn — the model's prompt carries the
  // handoff directive so it doesn't read its own present_plan "stop here" as halt.
  engine.send({ type: "set-mode", mode: "execute" });
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  expect(prompts.at(-1)).toContain("approved by the user");
});
