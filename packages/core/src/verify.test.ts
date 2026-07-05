import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import type { UIEvent, ToolDefinition } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig, type Config } from "@vibe/config";
import { Engine } from "./engine.ts";
import { runVerify } from "./verify.ts";

test("runVerify reports success and failure with captured output", async () => {
  const pass = await runVerify(process.cwd(), "exit 0");
  expect(pass.ok).toBe(true);
  const fail = await runVerify(process.cwd(), "echo boom 1>&2; exit 1");
  expect(fail.ok).toBe(false);
  expect(fail.output).toContain("boom");
});

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
// Reusable CHUNK DATA (not streams) — a fresh stream is built per doStream call,
// since a ReadableStream can only be consumed once.
const MUTATE_STEP = [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: "c", toolName: "edit_stub", input: "{}" },
  { type: "finish", finishReason: "tool-calls", usage: USAGE },
];
const FINAL_STEP = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "ok" },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: "stop", usage: USAGE },
];
const mutateThenDone = [MUTATE_STEP, FINAL_STEP];
const chatOnly = [FINAL_STEP];

function makeEngine(steps: unknown[][], verify: Config["verify"]) {
  // A non-read-only tool so the turn registers as a mutation.
  const editStub: ToolDefinition<Record<string, never>> = {
    name: "edit_stub",
    description: "pretend edit",
    inputSchema: z.object({}),
    readOnly: false,
    execute: async () => ({ output: "edited" }),
  };
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      const chunks = steps[call++ % steps.length] as never[];
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }),
      } as never;
    },
  });
  const registry = new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", verify },
    registry,
    toolset: new Toolset([editStub]),
    interactive: false, // auto-allow the side-effecting tool
    // Isolated, non-git cwd so checkpoints no-op and the real repo is untouched.
    cwd: mkdtempSync(join(tmpdir(), "vibe-verify-")),
  });
  const events: UIEvent[] = [];
  void (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  return { engine, events };
}

test("auto-verify retries on failure up to maxRetries, then stops", async () => {
  const { engine, events } = makeEngine(mutateThenDone, {
    command: "exit 1",
    auto: true,
    maxRetries: 2,
  });
  engine.send({ type: "submit-prompt", text: "make an edit" });
  await engine.whenIdle();

  const verifies = events.filter((e) => e.type === "verify-started").length;
  expect(verifies).toBe(3); // initial turn + 2 retries
  expect(
    events.some((e) => e.type === "notice" && e.message.includes("stopping auto-fix")),
  ).toBe(true);
});

test("auto-verify does not run when the turn made no edits", async () => {
  const { engine, events } = makeEngine(chatOnly, {
    command: "exit 1",
    auto: true,
    maxRetries: 2,
  });
  engine.send({ type: "submit-prompt", text: "hi" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "verify-started")).toBe(false);
});

test("a passing verify command triggers no retry", async () => {
  const { engine, events } = makeEngine(mutateThenDone, {
    command: "exit 0",
    auto: true,
    maxRetries: 2,
  });
  engine.send({ type: "submit-prompt", text: "edit" });
  await engine.whenIdle();
  expect(events.filter((e) => e.type === "verify-started").length).toBe(1);
});

test("auto-verify is killed by an abort — a long verify command can't wedge the queue", async () => {
  // #runVerifyCommand now runs through bunExec with the session abort signal +
  // killTree, so Esc (or steer/loop-stop) reaches a watch-mode/long verify
  // command instead of hanging the FIFO queue on it forever.
  const { engine, events } = makeEngine(mutateThenDone, {
    command: "sleep 30",
    auto: true,
    maxRetries: 0,
  });
  // Abort the moment the verify command starts (before its 30s elapses).
  void (async () => {
    for await (const e of engine.events()) {
      if (e.type === "verify-started") engine.send({ type: "abort" });
    }
  })();
  const start = Date.now();
  engine.send({ type: "submit-prompt", text: "edit" });
  await engine.whenIdle();
  // Killed promptly, not waited out.
  expect(Date.now() - start).toBeLessThan(5000);
  const finished = events.find((e) => e.type === "verify-finished");
  expect(finished && finished.type === "verify-finished" && finished.ok).toBe(false);
});

test("runVerify bounds a high-volume command's output in memory", async () => {
  const start = Date.now();
  const r = await runVerify(process.cwd(), "yes xxxxxxxxxxxxxxxxxxxxxxxxxxxx | head -100000; exit 1");
  expect(r.ok).toBe(false);
  expect(r.output).toContain("truncated");
  expect(r.output.length).toBeLessThan(9000); // ~8k display cap + marker, not ~3MB
  expect(Date.now() - start).toBeLessThan(5000);
});
