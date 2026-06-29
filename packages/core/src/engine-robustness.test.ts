import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig } from "@vibe/config";
import type { UIEvent } from "@vibe/shared";
import { Engine } from "./engine.ts";

/**
 * Robustness: simulate how REAL models actually behave on real codebases —
 * including mistakes (non-unique edits, malformed args, parallel edits to one
 * file, failing commands) — and verify the agent stays correct and recovers.
 */
function stream(chunks: unknown[]) {
  return { stream: simulateReadableStream({ chunks: chunks as never[], initialDelayInMs: 0, chunkDelayInMs: 0 }) };
}
const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };
const toolCall = (id: string, name: string, input: unknown) => ({
  type: "tool-call",
  toolCallId: id,
  toolName: name,
  input: JSON.stringify(input),
});
const step = (...calls: unknown[]) =>
  stream([{ type: "stream-start", warnings: [] }, ...calls, { type: "finish", finishReason: "tool-calls", usage: USAGE }]);
const textStep = (t: string) =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: t },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]);

function drive(steps: unknown[], cwd: string, config = defaultConfig()) {
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
  return { engine, events, collector };
}

async function run(d: ReturnType<typeof drive>, prompt: string) {
  await d.engine.bootstrap();
  d.engine.send({ type: "submit-prompt", text: prompt });
  await d.engine.whenIdle();
  d.engine.send({ type: "shutdown" });
  await d.collector;
}

test("recovers from a non-unique edit by retrying with replaceAll", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-rob-"));
  writeFileSync(join(cwd, "f.txt"), "x x x\n");
  const d = drive(
    [
      step(toolCall("c1", "edit", { path: "f.txt", oldString: "x", newString: "y" })), // ambiguous → error
      step(toolCall("c2", "edit", { path: "f.txt", oldString: "x", newString: "y", replaceAll: true })), // fixed
      textStep("Replaced all occurrences."),
    ],
    cwd,
  );
  await run(d, "replace x with y everywhere in f.txt");
  // The first edit's error is fed back to the model as an "ERROR: …" result (a
  // soft error it can recover from), and the retry with replaceAll succeeds.
  const finishes = d.events.filter((e): e is Extract<UIEvent, { type: "tool-call-finished" }> => e.type === "tool-call-finished");
  expect(String(finishes[0]?.output)).toContain("ERROR");
  expect(String(finishes[0]?.output)).toContain("replaceAll");
  expect(await Bun.file(join(cwd, "f.txt")).text()).toBe("y y y\n");
});

test("parallel edits to the SAME file in one step do not lose a write (serial lock)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-rob-par-"));
  writeFileSync(join(cwd, "f.txt"), "alpha\nbeta\n");
  // Real models emit multiple tool calls in a single step; the AI SDK runs them
  // via Promise.all. Without serialization, read-modify-write would race and
  // drop one edit. The serial lock must apply both.
  const d = drive(
    [
      step(
        toolCall("c1", "edit", { path: "f.txt", oldString: "alpha", newString: "ALPHA" }),
        toolCall("c2", "edit", { path: "f.txt", oldString: "beta", newString: "BETA" }),
      ),
      textStep("Both edits applied."),
    ],
    cwd,
  );
  await run(d, "uppercase alpha and beta");
  expect(await Bun.file(join(cwd, "f.txt")).text()).toBe("ALPHA\nBETA\n");
});

test("a failing shell command is surfaced as an error, turn still completes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-rob-bash-"));
  const d = drive(
    [step(toolCall("c1", "bash", { command: "exit 7" })), textStep("The command failed with exit 7.")],
    cwd,
  );
  await run(d, "run the thing");
  const fin = d.events.find((e): e is Extract<UIEvent, { type: "tool-call-finished" }> => e.type === "tool-call-finished");
  // The failing command's output is fed back (as an "ERROR: …" result) so the
  // model can react; the turn still completes cleanly rather than aborting.
  expect(String(fin?.output)).toContain("exit 7");
  expect(d.events.some((e) => e.type === "turn-finished")).toBe(true);
});

test("malformed tool args produce a clear error, not a crash", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-rob-bad-"));
  writeFileSync(join(cwd, "f.txt"), "hi\n");
  // Model 'forgets' to provide oldString/newString or edits — edit must reject
  // with guidance rather than throwing.
  const d = drive(
    [step(toolCall("c1", "edit", { path: "f.txt" })), textStep("I need to specify what to change.")],
    cwd,
  );
  await run(d, "edit the file");
  const fin = d.events.find((e): e is Extract<UIEvent, { type: "tool-call-finished" }> => e.type === "tool-call-finished");
  // Edit rejects with actionable guidance (no crash) and the file is untouched.
  expect(String(fin?.output)).toMatch(/oldString|edits/);
  expect(await Bun.file(join(cwd, "f.txt")).text()).toBe("hi\n"); // unchanged
});

test("a realistic grep -> read -> edit workflow on a real file", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-rob-flow-"));
  writeFileSync(join(cwd, "app.ts"), "const TODO = 1;\nexport const x = TODO;\n");
  const d = drive(
    [
      step(toolCall("c1", "grep", { pattern: "TODO" })),
      step(toolCall("c2", "read", { path: "app.ts" })),
      step(toolCall("c3", "edit", { path: "app.ts", oldString: "TODO", newString: "DONE", replaceAll: true })),
      textStep("Renamed TODO to DONE."),
    ],
    cwd,
  );
  await run(d, "rename TODO to DONE");
  expect(await Bun.file(join(cwd, "app.ts")).text()).toBe("const DONE = 1;\nexport const x = DONE;\n");
  // All three tools ran in order without error.
  const tools = d.events
    .filter((e): e is Extract<UIEvent, { type: "tool-call-started" }> => e.type === "tool-call-started")
    .map((e) => e.toolName);
  expect(tools).toEqual(["grep", "read", "edit"]);
});
