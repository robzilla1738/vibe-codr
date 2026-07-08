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

test("plan approval: card-accept and mode-switch share one routine (same execute + ask + handoff effects)", async () => {
  // Both approval surfaces funnel through the SAME #approvePlan/#setModeGated
  // routine, so neither can drift from the engine-owned invariant: approving a
  // plan lands in EXECUTE with the USER'S approval preference honored (auto
  // stays auto — approving a plan from yolo must launch unattended execution,
  // not silently re-gate it; ask stays gated ask) and arms the plan→execute
  // handoff (the execute turn's model prompt carries the "approved by the
  // user" directive). The two differ ONLY in WHEN the turn runs — the card
  // immediately, the mode switch on the next message — so we assert the
  // SHARED effects, not a byte-identical event stream.
  const PLAN = "## Steps\n- [ ] Refactor the loader\n- [ ] Add tests";

  async function approveVia(method: "card" | "mode", baseline: "ask" | "auto" = "auto") {
    const cwd = mkdtempSync(join(tmpdir(), `vibe-scn-approve-${method}-${baseline}-`));
    const prompts: string[] = [];
    const steps = [
      stream([
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "p1", toolName: "present_plan", input: JSON.stringify({ plan: PLAN }) },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ]),
      textStep("Plan presented."),
      textStep("Implementing the plan."),
    ];
    let call = 0;
    const model = new MockLanguageModelV2({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return steps[call++] as never;
      },
    });
    const registry = new ProviderRegistry([
      { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
    ]);
    // The baseline approval preference is what approval must HONOR: auto in →
    // auto out (yolo execution), ask in → gated ask.
    const engine = new Engine({
      config: { ...defaultConfig(), model: "mock/test", mode: "plan", approvalMode: baseline },
      cwd,
      registry,
      interactive: false,
    });
    await engine.bootstrap();
    const events: UIEvent[] = [];
    const collector = (async () => {
      for await (const e of engine.events()) events.push(e);
    })();

    engine.send({ type: "submit-prompt", text: "plan a refactor" });
    await engine.whenIdle();

    if (method === "card") {
      engine.send({ type: "resolve-plan", decision: "accept" }); // runs immediately
      await engine.whenIdle();
    } else {
      // Explicit /execute-style approve+start (start:true). Bare set-mode
      // (Shift+Tab) no longer auto-approves a waiting plan.
      engine.send({ type: "set-mode", mode: "execute", start: true });
      await engine.whenIdle();
    }
    engine.send({ type: "shutdown" });
    await collector;

    return {
      execPrompt: prompts.at(-1) ?? "",
      mode: engine.snapshot().mode,
      approvals: engine.snapshot().approvalMode,
      reGatedToAsk: events.some((e) => e.type === "approvals-changed" && e.mode === "ask"),
    };
  }

  const card = await approveVia("card");
  const mode = await approveVia("mode");

  // Shared effect 1: both land in EXECUTE.
  expect(card.mode).toBe("execute");
  expect(mode.mode).toBe("execute");
  // Shared effect 2: the user's AUTO preference survives approval on both
  // surfaces — a plan approved from yolo runs unattended.
  expect(card.approvals).toBe("auto");
  expect(mode.approvals).toBe("auto");
  // Shared effect 3: both arm the handoff — the execute turn's model prompt
  // carries the approval directive (its present_plan "stop here" no longer holds).
  expect(card.execPrompt).toContain("approved by the user");
  expect(mode.execPrompt).toContain("approved by the user");

  // With a gated ASK baseline the same routine keeps execution gated: approvals
  // land (and stay) in ask on both surfaces.
  const cardAsk = await approveVia("card", "ask");
  expect(cardAsk.mode).toBe("execute");
  expect(cardAsk.approvals).toBe("ask");
  expect(cardAsk.execPrompt).toContain("approved by the user");
});

test("bare set-mode (Shift+Tab) does NOT auto-approve a waiting plan", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-scn-defer-"));
  const config = { ...defaultConfig(), mode: "plan" as const };
  const { engine, events, collector } = mockEngine(
    [toolStep("c1", "present_plan", { plan: "# Plan\n1. do the thing" }), textStep("Plan ready.")],
    cwd,
    config,
  );
  await engine.bootstrap();
  engine.send({ type: "submit-prompt", text: "plan the work" });
  await engine.whenIdle();
  // Shift+Tab-style bare set-mode: stay in plan, no approval, no seed.
  engine.send({ type: "set-mode", mode: "execute" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  expect(engine.snapshot().mode).toBe("plan");
  expect(
    events.some(
      (e) =>
        e.type === "notice" &&
        typeof e.message === "string" &&
        e.message.includes("waiting for approval"),
    ),
  ).toBe(true);
  expect(events.filter((e) => e.type === "notice" && e.message.includes("Plan approved")).length).toBe(
    0,
  );
  expect(events.filter((e) => e.type === "tasks-updated").length).toBe(0);
});

test("a mid-turn mode flip cannot smuggle a mutating turn past the gate", async () => {
  // The turn STARTED in execute and mutated; flipping to plan while it streams
  // must not make #afterTurn judge it by the new mode and skip verification
  // entirely (here: the honest UNVERIFIED notice for a checkless workspace).
  const { z } = await import("zod");
  const { Toolset } = await import("@vibe/tools");
  const cwd = mkdtempSync(join(tmpdir(), "vibe-scn-flip-gate-"));
  let engineRef: Engine;
  const toolset = new Toolset([
    {
      name: "mutate_flip",
      description: "mutates, then the user flips mode mid-turn",
      inputSchema: z.object({}),
      readOnly: false,
      concurrencySafe: false,
      execute: async () => {
        writeFileSync(join(cwd, "made.txt"), "x\n");
        engineRef.send({ type: "set-mode", mode: "plan" }); // immediate, mid-turn
        return { output: "mutated" };
      },
    },
  ]);
  let call = 0;
  const steps = [toolStep("c1", "mutate_flip", {}), textStep("Done.")];
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const registry = new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
  engineRef = new Engine({
    config: { ...defaultConfig(), model: "mock/test" },
    cwd,
    registry,
    toolset,
    interactive: false,
  });
  const events: UIEvent[] = [];
  const sub = engineRef.events();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();
  await engineRef.bootstrap();
  engineRef.send({ type: "submit-prompt", text: "make the file" });
  await engineRef.whenIdle();
  engineRef.send({ type: "shutdown" });
  await collector;

  expect(existsSync(join(cwd, "made.txt"))).toBe(true);
  expect(
    events.some((e) => e.type === "notice" && e.message.includes("UNVERIFIED")),
  ).toBe(true);
});

test("a denied handoff prompt re-arms the plan approval (the next message retries it)", async () => {
  // #pendingHandoff is consumed off the flag at enqueue and bound to the job. A
  // user.prompt.submit deny used to lose the approval entirely (#lastPlan was
  // already spent), so only --resume could resurrect it. The deny branch now
  // re-arms #pendingHandoff so the user's next message retries the handoff.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-scn-handoff-deny-"));
  const PLAN = "## Steps\n- [ ] Do the thing";
  const prompts: string[] = [];
  const steps = [
    toolStep("p1", "present_plan", { plan: PLAN }),
    textStep("Plan presented."),
    textStep("Implementing."),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return steps[Math.min(call++, steps.length - 1)] as never;
    },
  });
  const registry = new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", mode: "plan" },
    cwd,
    registry,
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  // Deny the FIRST handoff attempt only; allow the retry.
  let handoffDenies = 0;
  engine.hooks.on("user.prompt.submit", (p) => {
    if (p.text.includes("Proceed with the approved plan") && handoffDenies === 0) {
      handoffDenies += 1;
      return { ...p, deny: true };
    }
    return p;
  });

  engine.send({ type: "submit-prompt", text: "plan it" });
  await engine.whenIdle();
  // start:true begins the handoff immediately; the prompt-submit deny re-arms it.
  engine.send({ type: "set-mode", mode: "execute", start: true });
  await engine.whenIdle();
  engine.send({ type: "submit-prompt", text: "go again" }); // retries the re-armed handoff
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // The deny re-armed the approval and said so.
  expect(events.some((e) => e.type === "notice" && /Plan approval preserved/.test(e.message))).toBe(true);
  // The retry carried the handoff directive into the model prompt.
  expect(prompts.at(-1)).toContain("approved by the user");
});

test("/loop iteration runs built-in /status without prompting the model (BUG-075)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-scn-loop-"));
  let modelCalls = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      modelCalls += 1;
      return textStep("model should not run for /status loop tick") as never;
    },
  });
  const registry = new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test" },
    cwd,
    registry,
    interactive: false,
  });
  const events: UIEvent[] = [];
  const sub = engine.events();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();
  await engine.bootstrap();
  // Real slash path → handleLoop → #runLoopIteration → #handleSlash("status")
  engine.send({ type: "run-slash", name: "loop", args: "1s /status --max 1" });
  for (let i = 0; i < 80; i++) {
    if (events.some((e) => e.type === "loop-stopped")) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  engine.send({ type: "shutdown" });
  await collector;

  expect(events.some((e) => e.type === "loop-stopped")).toBe(true);
  // Built-in /status emits a notice; it must not burn a model turn.
  const statusNotice = events.find(
    (e) => e.type === "notice" && /model|cwd|session|status/i.test(e.message),
  );
  expect(statusNotice).toBeDefined();
  expect(modelCalls).toBe(0);
});
