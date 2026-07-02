import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
function makeEngine(
  steps: unknown[],
  interactive: boolean,
  permissions: { tool: string; match?: string; action: "allow" | "deny" | "ask" }[] = [],
) {
  let runs = 0;
  const danger: ToolDefinition<{ command?: string }> = {
    name: "danger",
    description: "side effect",
    inputSchema: z.object({ command: z.string().optional() }),
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
    config: { ...defaultConfig(), model: "mock/test", permissions },
    registry,
    toolset: new Toolset([danger]),
    interactive,
    cwd: mkdtempSync(join(tmpdir(), "vibe-perm-")), // isolated, non-git
  });
  return { engine, runs: () => runs };
}

/** A `danger` tool call carrying a `command` scope (for scoped-rule tests). */
function toolCallCmd(id: string, command: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: id, toolName: "danger", input: JSON.stringify({ command }) },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
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

test("interactive: two tool calls in one step each get a distinct prompt", async () => {
  const twoCalls = {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "c1", toolName: "danger", input: "{}" },
        { type: "tool-call", toolCallId: "c2", toolName: "danger", input: "{}" },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
  const { engine, runs } = makeEngine([twoCalls, finalText()], true);
  const events = drive(engine, "once");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();

  const ids = events
    .filter((e) => e.type === "permission-request")
    .map((e) => (e as Extract<UIEvent, { type: "permission-request" }>).id);
  expect(ids.length).toBe(2);
  expect(new Set(ids).size).toBe(2); // distinct ids, both resolvable
  expect(runs()).toBe(2);
});

test("re-gating approvals to ask forgets a prior 'always' grant (it can't bypass the fresh gate)", async () => {
  // Prompt 1: model calls danger → user grants 'always'. Then approvals are
  // re-gated to ask (a /plan/-execute/plan-accept transition). Prompt 2's danger
  // call must PROMPT AGAIN — the old 'always' grant must not silently bypass it.
  const { engine, runs } = makeEngine(
    [toolCall("c1"), finalText(), toolCall("c2"), finalText()],
    true,
  );
  const events: UIEvent[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      if (e.type === "permission-request") engine.send({ type: "resolve-permission", id: e.id, decision: "always" });
    }
  })();
  engine.send({ type: "submit-prompt", text: "one" });
  await engine.whenIdle();
  const asksAfter1 = events.filter((e) => e.type === "permission-request").length;
  expect(asksAfter1).toBe(1); // asked once, remembered

  // Re-gate to ask (clears the always-allow set).
  engine.send({ type: "run-slash", name: "execute", args: "" });
  await engine.whenIdle();

  engine.send({ type: "submit-prompt", text: "two" });
  await engine.whenIdle();
  const asksTotal = events.filter((e) => e.type === "permission-request").length;
  // A SECOND prompt was required for the second danger call — the grant didn't carry over.
  expect(asksTotal).toBe(2);
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

test("non-interactive: an EXPLICIT ask rule fails CLOSED (a human gate can't auto-allow)", async () => {
  // A deliberately-authored `{action:"ask"}` gate must not silently become
  // `allow` in a headless run — there is no human to approve.
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], false, [
    { tool: "danger", action: "ask" },
  ]);
  const events = drive(engine, "once");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "permission-request")).toBe(false); // nothing to answer
  expect(runs()).toBe(0); // blocked, not run
  expect(events.some((e) => e.type === "notice" && e.message.includes("Blocked danger"))).toBe(true);
});

test("interactive: 'always' is remembered per content scope, not for the whole tool", async () => {
  // Approving `danger {command:"safe"}` with 'always' must NOT auto-allow a later
  // `danger {command:"rm -rf /"}` — that call still prompts.
  const { engine, runs } = makeEngine(
    [toolCallCmd("c1", "safe"), toolCallCmd("c2", "rm -rf /"), finalText()],
    true,
  );
  const events: UIEvent[] = [];
  const prompts: string[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      if (e.type === "permission-request") {
        prompts.push(JSON.stringify(e.input));
        // 'always' the first (safe) call; 'deny' the second (rm) call.
        const decision = prompts.length === 1 ? "always" : "deny";
        engine.send({ type: "resolve-permission", id: e.id, decision });
      }
    }
  })();
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  // Both calls prompted — the 'always' for "safe" did not cover "rm -rf /".
  expect(prompts.length).toBe(2);
  expect(runs()).toBe(1); // only the safe one ran
});
