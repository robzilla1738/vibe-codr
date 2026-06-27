import { test, expect } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import type { UIEvent, ToolDefinition } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { Engine } from "./engine.ts";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function toolCall(id: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: id, toolName: "danger", input: "{}" },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}
function finalText() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "done" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}

/** Build an engine whose model runs `steps`, with a counting `danger` tool. */
function makeEngine(steps: unknown[], interactive: boolean) {
  let runs = 0;
  const danger: ToolDefinition<Record<string, never>> = {
    name: "danger",
    description: "side effect",
    inputSchema: z.object({}),
    readOnly: false,
    execute: async () => {
      runs += 1;
      return { output: "did it" };
    },
  };
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const registry = new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test" },
    registry,
    toolset: new Toolset([danger]),
    interactive,
  });
  return { engine, runs: () => runs };
}

/** Auto-answer every permission-request with `decision`; collect events. */
function drive(engine: Engine, decision: "once" | "always" | "deny") {
  const events: UIEvent[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      if (e.type === "permission-request") {
        engine.send({ type: "resolve-permission", id: e.id, decision });
      }
    }
  })();
  return events;
}

test("interactive: an allowed (once) permission lets the tool run", async () => {
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], true);
  const events = drive(engine, "once");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "permission-request")).toBe(true);
  expect(runs()).toBe(1);
});

test("interactive: a denied permission blocks the tool", async () => {
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], true);
  const events = drive(engine, "deny");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "permission-request")).toBe(true);
  expect(runs()).toBe(0);
  expect(events.some((e) => e.type === "notice" && e.message.includes("Blocked danger"))).toBe(true);
});

test("interactive: 'always' suppresses the second prompt", async () => {
  const { engine, runs } = makeEngine(
    [toolCall("c1"), toolCall("c2"), finalText()],
    true,
  );
  const events = drive(engine, "always");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  const asks = events.filter((e) => e.type === "permission-request").length;
  expect(asks).toBe(1); // asked once, remembered for the second call
  expect(runs()).toBe(2);
});

test("non-interactive: side-effecting tools auto-allow without prompting", async () => {
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], false);
  const events = drive(engine, "deny"); // would deny if asked
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "permission-request")).toBe(false);
  expect(runs()).toBe(1);
});
