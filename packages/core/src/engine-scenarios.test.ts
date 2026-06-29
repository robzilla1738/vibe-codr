import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig, type Config } from "@vibe/config";
import type { UIEvent } from "@vibe/shared";
import { Engine } from "./engine.ts";

function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({ chunks: chunks as never[], initialDelayInMs: 0, chunkDelayInMs: 0 }),
  };
}
const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const toolStep = (id: string, name: string, input: unknown) =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]);
const textStep = (text: string) =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]);

function mockEngine(steps: unknown[], cwd: string, config: Config) {
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const registry = new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
  const engine = new Engine({ config: { ...config, model: "mock/test" }, cwd, registry, interactive: false });
  const events: UIEvent[] = [];
  const sub = engine.events();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();
  return { engine, events, collector, calls: () => call };
}

test("execute: model edits a real file and the change is applied + surfaced", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-scn-edit-"));
  writeFileSync(join(cwd, "note.txt"), "the old value\n");
  const { engine, events, collector } = mockEngine(
    [toolStep("c1", "edit", { path: "note.txt", oldString: "old", newString: "new" }), textStep("Updated the note.")],
    cwd,
    defaultConfig(),
  );
  await engine.bootstrap();
  engine.send({ type: "submit-prompt", text: "change old to new in note.txt" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  expect(await Bun.file(join(cwd, "note.txt")).text()).toBe("the new value\n");
  const changed = events.find((e) => e.type === "file-changed");
  expect(changed && changed.type === "file-changed" && changed.action).toBe("edit");
  const text = events
    .filter((e): e is Extract<UIEvent, { type: "assistant-text-delta" }> => e.type === "assistant-text-delta")
    .map((e) => e.delta)
    .join("");
  expect(text).toBe("Updated the note.");
});

test("plan mode: present_plan emits a plan and no file is mutated", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-scn-plan-"));
  const config = { ...defaultConfig(), mode: "plan" as const };
  const { engine, events, collector } = mockEngine(
    [toolStep("c1", "present_plan", { plan: "# Plan\n1. do the thing" }), textStep("Plan is ready for review.")],
    cwd,
    config,
  );
  await engine.bootstrap();
  engine.send({ type: "submit-prompt", text: "plan the work" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  const plan = events.find((e) => e.type === "plan-presented");
  expect(plan && plan.type === "plan-presented" && plan.plan).toContain("do the thing");
  // Plan mode is read-only: nothing should have been written.
  expect(events.some((e) => e.type === "file-changed")).toBe(false);
});

test("subagent: the parent delegates, gets the child's answer, and folds its cost", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-scn-sub-"));
  // Parent spawns a subagent; the child answers; the parent reports back. The
  // shared mock counter feeds: parent tool-call -> child final -> parent final.
  const { engine, events, collector } = mockEngine(
    [
      toolStep("c1", "spawn_subagent", { prompt: "count the files" }),
      textStep("There are 3 files."), // child's answer
      textStep("The subagent found 3 files."), // parent's final summary
    ],
    cwd,
    defaultConfig(),
  );
  await engine.bootstrap();
  engine.send({ type: "submit-prompt", text: "delegate a count" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  expect(events.some((e) => e.type === "subagent-started")).toBe(true);
  const done = events.find((e) => e.type === "subagent-finished");
  expect(done && done.type === "subagent-finished" && done.result).toContain("3 files");
  // Cost is folded into the parent: a usage-updated reflects the child's tokens.
  expect(events.some((e) => e.type === "usage-updated")).toBe(true);
});

test("auto-verify: a failing check feeds back and the agent self-corrects", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-scn-verify-"));
  writeFileSync(join(cwd, "seed.txt"), "start\n");
  const config: Config = {
    ...defaultConfig(),
    // Passes only once the agent has created done.flag.
    verify: { command: "test -f done.flag", auto: true, maxRetries: 2 },
  };
  const { engine, events, collector, calls } = mockEngine(
    [
      // Turn 1: a mutating edit that does NOT yet satisfy the check.
      toolStep("c1", "edit", { path: "seed.txt", oldString: "start", newString: "progress" }),
      textStep("First attempt."),
      // Turn 2 (the auto-enqueued verify-fix prompt): create the flag the check wants.
      toolStep("c2", "write", { path: "done.flag", content: "ok" }),
      textStep("Fixed the verification."),
    ],
    cwd,
    config,
  );
  await engine.bootstrap();
  engine.send({ type: "submit-prompt", text: "make the change" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // The agent ran a second, self-corrected turn driven by the failing verify.
  expect(calls()).toBe(4);
  expect(existsSync(join(cwd, "done.flag"))).toBe(true);
  const verifyResults = events.filter(
    (e): e is Extract<UIEvent, { type: "verify-finished" }> => e.type === "verify-finished",
  );
  expect(verifyResults.some((e) => !e.ok)).toBe(true); // first check failed
  expect(verifyResults.some((e) => e.ok)).toBe(true); // second check passed
});
