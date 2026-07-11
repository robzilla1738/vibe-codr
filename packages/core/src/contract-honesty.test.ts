/**
 * Contract honesty tests — acceptance criteria for modes, permissions,
 * plan handoff, and post-turn verify/follow-up. Drive the real Engine /
 * Session / Toolset paths (mock model only; no re-implemented policy).
 */
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import type { ToolDefinition, UIEvent } from "@vibe/shared";
import { Engine, applyGateToVerdict } from "./engine.ts";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({
      chunks: chunks as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}
const textStep = (text: string) =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]);
const toolStep = (id: string, name: string, input: unknown = {}) =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]);
const writeStep = (id: string, path: string, content: string) =>
  toolStep(id, "write", { path, content });

function mockRegistry(model: MockLanguageModelV2): ProviderRegistry {
  return new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => model,
      listModels: async () => [],
    },
  ]);
}

function notices(events: UIEvent[]) {
  return events.filter((e): e is Extract<UIEvent, { type: "notice" }> => e.type === "notice");
}

function initGitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vibe-contract-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const g = (args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.dev"]);
  g(["config", "user.name", "t"]);
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
  return dir;
}

// ── AC1: mid-turn plan hard-denies subsequent writes ─────────────────────────

test("mid-turn flip to plan hard-denies a later write tool in the same turn", async () => {
  // Tools map is frozen at run() start with execute tools; liveMode must still
  // block non-readOnly tools once the user flips to plan mid-turn.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-midplan-"));
  let engineRef: Engine;
  const flip: ToolDefinition = {
    name: "flip_to_plan",
    description: "flip",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => {
      engineRef.send({ type: "set-mode", mode: "plan" });
      return { output: "flipped" };
    },
  };
  const writer: ToolDefinition = {
    name: "force_write",
    description: "write",
    inputSchema: z.object({}),
    readOnly: false,
    concurrencySafe: false,
    execute: async () => {
      writeFileSync(join(cwd, "should-not-exist.txt"), "x\n");
      return { output: "wrote" };
    },
  };
  let call = 0;
  const steps = [toolStep("f1", "flip_to_plan"), toolStep("w1", "force_write"), textStep("done")];
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  engineRef = new Engine({
    config: { ...defaultConfig(), model: "mock/test", mode: "execute", approvalMode: "auto" },
    cwd,
    registry: mockRegistry(model),
    toolset: new Toolset([flip, writer]),
    interactive: false,
  });
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engineRef.events()) events.push(e);
  })();
  await engineRef.bootstrap();
  engineRef.send({ type: "submit-prompt", text: "flip then write" });
  await engineRef.whenIdle();
  engineRef.send({ type: "shutdown" });
  await collector;

  expect(existsSync(join(cwd, "should-not-exist.txt"))).toBe(false);
  expect(notices(events).some((n) => /Blocked force_write.*plan mode/i.test(n.message))).toBe(true);
  expect(engineRef.snapshot().mode).toBe("plan");
});

// ── AC1: mid-turn YOLO → ASK re-gates subsequent tools ───────────────────────

test("mid-turn re-gate to ask prompts on the next unmatched mutating tool", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-regate-"));
  let runs = 0;
  let engineRef: Engine;
  const regate: ToolDefinition = {
    name: "to_ask",
    description: "re-gate",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => {
      engineRef.send({ type: "set-approvals", mode: "ask", quiet: true });
      return { output: "ask" };
    },
  };
  const danger: ToolDefinition = {
    name: "danger",
    description: "mutate",
    inputSchema: z.object({}),
    readOnly: false,
    concurrencySafe: false,
    execute: async () => {
      runs += 1;
      return { output: "ran" };
    },
  };
  let call = 0;
  // First danger under YOLO (auto) runs free; after to_ask, second danger must ask.
  const steps = [
    toolStep("d1", "danger"),
    toolStep("a1", "to_ask"),
    toolStep("d2", "danger"),
    textStep("done"),
  ];
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  engineRef = new Engine({
    config: {
      ...defaultConfig(),
      model: "mock/test",
      mode: "execute",
      approvalMode: "auto",
    },
    cwd,
    registry: mockRegistry(model),
    toolset: new Toolset([regate, danger]),
    interactive: true,
  });
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engineRef.events()) {
      events.push(e);
      if (e.type === "permission-request") {
        engineRef.send({ type: "resolve-permission", id: e.id, decision: "once" });
      }
    }
  })();
  await engineRef.bootstrap();
  engineRef.send({ type: "submit-prompt", text: "yolo then ask" });
  await engineRef.whenIdle();
  engineRef.send({ type: "shutdown" });
  await collector;

  // Only the second danger should have prompted (first was under auto).
  const asks = events.filter((e) => e.type === "permission-request").length;
  expect(asks).toBe(1);
  expect(runs).toBe(2);
  expect(engineRef.snapshot().approvalMode).toBe("ask");
});

// ── AC3: denied-only turn does not trip mutate-driven gate ───────────────────

test("permission-denied mutating tools do not trip the green-gate / UNVERIFIED path", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-deny-gate-"));
  let runs = 0;
  const danger: ToolDefinition = {
    name: "danger",
    description: "mutate",
    inputSchema: z.object({}),
    readOnly: false,
    concurrencySafe: false,
    execute: async () => {
      runs += 1;
      writeFileSync(join(cwd, "leaked.txt"), "nope\n");
      return { output: "ran" };
    },
  };
  let call = 0;
  const steps = [toolStep("d1", "danger"), textStep("blocked")];
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const engine = new Engine({
    config: {
      ...defaultConfig(),
      model: "mock/test",
      mode: "execute",
      approvalMode: "ask",
    },
    cwd,
    registry: mockRegistry(model),
    toolset: new Toolset([danger]),
    interactive: true,
  });
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      if (e.type === "permission-request") {
        engine.send({ type: "resolve-permission", id: e.id, decision: "deny" });
      }
    }
  })();
  await engine.bootstrap();
  engine.send({ type: "submit-prompt", text: "try to mutate" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  expect(runs).toBe(0);
  expect(existsSync(join(cwd, "leaked.txt"))).toBe(false);
  // No machine-verify path for a denied-only turn (didMutate stays false).
  expect(notices(events).some((n) => n.message.includes("UNVERIFIED"))).toBe(false);
  expect(notices(events).some((n) => n.message.startsWith("Gate:"))).toBe(false);
});

// ── AC2: returning to plan disarms plan-execution continuations ──────────────

test("switching back to plan after plan approval disarms task auto-continuations", async () => {
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { test: "echo '3 pass'" },
    }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  const prompts: string[] = [];
  const PLAN = "## Steps\n- [ ] Do t1\n- [ ] Do t2";
  let call = 0;
  let releaseContinue!: () => void;
  const holdContinue = new Promise<void>((r) => {
    releaseContinue = r;
  });
  let sawContinue = false;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const p = JSON.stringify(options.prompt);
      prompts.push(p);
      const i = call++;
      if (i === 0) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "p1",
            toolName: "present_plan",
            input: JSON.stringify({ plan: PLAN }),
          },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ]) as never;
      }
      if (i === 1) return textStep("Plan ready.") as never;
      if (i === 2) return writeStep("w1", "out.txt", "partial\n") as never;
      if (i === 3) return textStep("started t1 only") as never;
      // First task-continuation: hold so the test can flip to plan while the
      // chain is still armed (#planExecutionActive true).
      if (p.includes("The approved plan is not finished") && !sawContinue) {
        sawContinue = true;
        await holdContinue;
        return textStep("held continue") as never;
      }
      return textStep(`extra ${i}`) as never;
    },
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", mode: "plan" },
    cwd: dir,
    registry: mockRegistry(model),
    interactive: false,
  });
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  await engine.bootstrap();
  engine.send({ type: "submit-prompt", text: "plan the work" });
  await engine.whenIdle();
  engine.send({ type: "resolve-plan", decision: "accept" });

  // Wait until the task-continuation is held mid-flight.
  const deadline = Date.now() + 10_000;
  while (!sawContinue && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  expect(sawContinue).toBe(true);

  // Disarm while the plan-execution chain is still live.
  engine.send({ type: "set-mode", mode: "plan" });
  releaseContinue();
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  expect(
    notices(events).some((n) => /Plan execution paused|switched back to plan/i.test(n.message)),
  ).toBe(true);
  expect(engine.snapshot().mode).toBe("plan");
  // After the pause, no further "not finished" turns should be enqueued beyond
  // the one we held (disarm clears #planExecutionActive before it can re-arm).
  const continueCount = prompts.filter((p) =>
    p.includes("The approved plan is not finished"),
  ).length;
  expect(continueCount).toBe(1);
});

// ── AC3: dirty review suppresses plan-task continue until fix settles ────────

test("dirty adversarial review does not advance plan-task continuations before review-fix", async () => {
  // Hold the review-fix turn mid-flight. While it is held, no plan-task
  // continuation prompt may appear — that is the #fixPending contract
  // (continue only after the fix job starts and #afterTurn can re-drive).
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { test: "echo '3 pass'" },
    }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  const prompts: string[] = [];
  const PLAN = "## Steps\n- [ ] Do t1\n- [ ] Do t2";
  let streamCall = 0;
  let reviewCalls = 0;
  let sawFix = false;
  let releaseFix!: () => void;
  const holdFix = new Promise<void>((r) => {
    releaseFix = r;
  });
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const p = JSON.stringify(options.prompt);
      prompts.push(p);
      const i = streamCall++;
      if (i === 0) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "p1",
            toolName: "present_plan",
            input: JSON.stringify({ plan: PLAN }),
          },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ]) as never;
      }
      if (i === 1) return textStep("Plan ready.") as never;
      if (i === 2) return writeStep("w1", "out.txt", "partial\n") as never;
      if (i === 3) return textStep("partial work") as never;
      // Review-fix prompt carries the reviewer's concrete findings.
      if (p.includes("src.ts:1 issue") || p.includes("src.ts:1")) {
        sawFix = true;
        // Snapshot: while this fix is held, continue must not already be queued
        // as a concurrent stream (would mean parent #afterTurn advanced chains).
        const continuesBeforeRelease = prompts.filter((x) =>
          x.includes("The approved plan is not finished"),
        ).length;
        expect(continuesBeforeRelease).toBe(0);
        await holdFix;
        return textStep("fixed the review issue") as never;
      }
      if (p.includes("The approved plan is not finished")) {
        // Must only arrive after the fix turn was allowed to run.
        expect(sawFix).toBe(true);
        return textStep("continuing tasks") as never;
      }
      return textStep(`turn ${i}`) as never;
    },
    doGenerate: async () => {
      reviewCalls++;
      return {
        content: [{ type: "text", text: "NOT REVIEW-CLEAN — src.ts:1 issue" }],
        finishReason: "stop" as const,
        usage: USAGE,
        warnings: [],
      };
    },
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", mode: "plan" },
    cwd: dir,
    registry: mockRegistry(model),
    interactive: false,
  });
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  await engine.bootstrap();
  engine.send({ type: "submit-prompt", text: "plan" });
  await engine.whenIdle();
  engine.send({ type: "resolve-plan", decision: "accept" });

  const deadline = Date.now() + 15_000;
  while (!sawFix && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  expect(sawFix).toBe(true);
  // Still held: zero plan-task continues may have started.
  expect(prompts.filter((p) => p.includes("The approved plan is not finished")).length).toBe(0);

  releaseFix();
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  expect(reviewCalls).toBeGreaterThanOrEqual(1);
  expect(notices(events).some((n) => n.message.includes("Diff review flagged issues"))).toBe(true);
  // After the fix settles, task continuation is allowed again (unfinished tasks).
  const contAfter = prompts.filter((p) => p.includes("The approved plan is not finished"));
  expect(contAfter.length).toBeGreaterThanOrEqual(1);
  const fixIdx = prompts.findIndex((p) => p.includes("src.ts:1 issue") || p.includes("src.ts:1"));
  const contIdx = prompts.findIndex((p) => p.includes("The approved plan is not finished"));
  expect(fixIdx).toBeGreaterThanOrEqual(0);
  expect(contIdx).toBeGreaterThan(fixIdx);
});

// ── Quiet YOLO while plan waiting must not stick (Shift+Tab defense) ─────────

test("quiet set-approvals auto is ignored while a plan is waiting in plan mode", async () => {
  // Mirrors a buggy client that still sends YOLO after bare set-mode on a live
  // plan. Engine must not flip approvals — Enter would otherwise inherit YOLO.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-quiet-yolo-"));
  const steps = [toolStep("p1", "present_plan", { plan: "# Plan\n- [ ] step" }), textStep("ready")];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", mode: "plan", approvalMode: "ask" },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  engine.send({ type: "submit-prompt", text: "plan" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "plan-presented")).toBe(true);

  // Bare leave-plan (refused) + quiet YOLO (must be ignored).
  engine.send({ type: "set-mode", mode: "execute" });
  engine.send({ type: "set-approvals", mode: "auto", quiet: true });
  await engine.whenIdle();

  expect(engine.snapshot().mode).toBe("plan");
  expect(engine.snapshot().approvalMode).toBe("ask");
  // Explicit typed /approvals auto (not quiet) still works.
  engine.send({ type: "set-approvals", mode: "auto" });
  expect(engine.snapshot().approvalMode).toBe("auto");

  engine.send({ type: "shutdown" });
  await collector;
});

// ── applyGateToVerdict pure contract (AC3) ───────────────────────────────────

test("applyGateToVerdict: checksAvailable blocks met when gate is undefined", () => {
  const met = { met: true, gaps: [] as string[], reason: "done" };
  expect(applyGateToVerdict(met, "green").met).toBe(true);
  expect(applyGateToVerdict(met, undefined).met).toBe(true); // check-less free pass
  expect(applyGateToVerdict(met, undefined, { checksAvailable: true }).met).toBe(false);
  expect(applyGateToVerdict(met, "unverified", { checksAvailable: true }).met).toBe(false);
  expect(applyGateToVerdict(met, "red").met).toBe(false);
});
