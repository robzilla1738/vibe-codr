import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig } from "@vibe/config";
import type { UIEvent } from "@vibe/shared";
import { Engine, applyGateToVerdict } from "./engine.ts";
import { globalStateDir } from "./state-dir.ts";

// Machine state lives in the per-project GLOBAL state dir — point it at a temp
// root so tests never touch ~/.vibe/state (same setup as engine-e2e.test.ts).
process.env.VIBE_STATE_DIR ??= mkdtempSync(join(tmpdir(), "vibe-state-"));

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({
      chunks: chunks as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}

function textStep(t: string) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: t },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]);
}

function mockRegistry(model: MockLanguageModelV2): ProviderRegistry {
  return new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
}

/** A doGenerate that replays goal-assessment verdicts in order (the last one
 * repeats), as the JSON text generateObject parses. Captures each call's
 * prompt for evidence assertions. */
function assessments(verdicts: { met: boolean; gaps: string[]; reason: string }[]) {
  let i = 0;
  const prompts: string[] = [];
  const calls = () => i;
  const doGenerate = async (options: { prompt: unknown }) => {
    prompts.push(JSON.stringify(options.prompt));
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(verdicts[Math.min(i++, verdicts.length - 1)]) },
      ],
      finishReason: "stop" as const,
      usage: USAGE,
      warnings: [],
    };
  };
  return { doGenerate, calls, prompts };
}

/** A doStream step that emits one tool call (mirrors engine-e2e.test.ts). */
function toolCall(id: string, name: string, input: unknown) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]);
}

function collect(engine: Engine): { events: UIEvent[]; done: Promise<void> } {
  const events: UIEvent[] = [];
  const done = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  return { events, done };
}

test("/goal starts a run, continues past gaps, and finishes only after 2 clean passes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-run-"));
  const prompts: string[] = [];
  const assess = assessments([
    { met: false, gaps: ["README quickstart section missing"], reason: "docs incomplete" },
    { met: true, gaps: [], reason: "work looks complete" },
    { met: true, gaps: [], reason: "verified clean" },
  ]);
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textStep(`turn ${prompts.length} done`) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", goal: { maxRounds: 25, planFirst: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "write the README" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // The goal is set (the ★) AND announced as a run.
  expect(engine.snapshot().goal).toBe("write the README");
  expect(events.some((e) => e.type === "notice" && /Goal set: write the README/.test(e.message))).toBe(true);

  // Exactly three working turns: drive, gap continuation, adversarial verify.
  expect(prompts).toHaveLength(3);
  expect(prompts[0]).toContain("north-star goal");
  expect(prompts[0]).toContain("write the README");
  // The continuation names the assessed gap.
  expect(prompts[1]).toContain("README quickstart section missing");
  // The first clean pass buys a dedicated adversarial verify turn.
  expect(prompts[2]).toContain("TRULY met");

  // Every turn emitted a user-message — the transcript block that flips the TUI
  // from the splash to the working view.
  expect(events.filter((e) => e.type === "user-message")).toHaveLength(3);

  // Convergence: assessed after each turn, then declared verified-met.
  expect(assess.calls()).toBe(3);
  expect(
    events.some((e) => e.type === "notice" && /Goal met after .* verified across 2 consecutive clean passes/.test(e.message)),
  ).toBe(true);
});

test("/goal run stops at goal.maxRounds with a warn — the ★ stays set", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-bound-"));
  const prompts: string[] = [];
  const assess = assessments([{ met: false, gaps: ["still not done"], reason: "nope" }]);
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textStep("working") as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", goal: { maxRounds: 2, planFirst: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "solve the halting problem" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // Drive turn + exactly maxRounds continuations, then the bound trips (the
  // bound is checked before a new assessment, so only 2 assessments ran).
  expect(prompts).toHaveLength(3);
  expect(assess.calls()).toBe(2);
  expect(
    events.some(
      (e) => e.type === "notice" && e.level === "warn" && /not confirmed met after 2 continuation rounds/.test(e.message),
    ),
  ).toBe(true);
  // The goal is NOT met, so the ★ must survive for the user to act on.
  expect(engine.snapshot().goal).toBe("solve the halting problem");
});

test("/goal clear mid-run sweeps queued goal turns but NOT a queued loop iteration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-clear-"));
  const prompts: string[] = [];
  let releaseDrive!: () => void;
  const driveGate = new Promise<void>((r) => (releaseDrive = r));
  let signalDriveStarted!: () => void;
  const driveStarted = new Promise<void>((r) => (signalDriveStarted = r));
  let signalLoopRan!: () => void;
  const loopRan = new Promise<void>((r) => (signalLoopRan = r));

  const assess = assessments([{ met: false, gaps: ["more polish needed"], reason: "not yet" }]);
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const idx = prompts.length;
      prompts.push(JSON.stringify(options.prompt));
      if (idx === 0) {
        signalDriveStarted();
        await driveGate; // hold the drive turn so /loop and /goal clear queue behind it
      } else {
        signalLoopRan();
      }
      return textStep(`turn ${idx}`) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: {
      ...defaultConfig(),
      model: "mock/test",
      checkpoints: { enabled: false },
      goal: { maxRounds: 25, planFirst: false },
    },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "keep polishing" });
  await driveStarted; // the drive turn's model call is in flight
  // Queue a loop (its iteration gets a `loop:` label) and then clear the goal.
  engine.send({ type: "run-slash", name: "loop", args: "1h ping --max 1" });
  engine.send({ type: "run-slash", name: "goal", args: "clear" });
  releaseDrive();
  await loopRan; // the loop iteration survived the goal sweep and ran
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // The goal continuation (enqueued by the drive turn's failed assessment) was
  // swept by /goal clear — no turn ever received the "not yet met" prompt.
  expect(prompts.some((p) => p.includes("not yet met"))).toBe(false);
  // The loop iteration was NOT swept (label prefixes are disjoint) and ran.
  expect(prompts.some((p) => p.includes("ping"))).toBe(true);
  expect(engine.snapshot().goal).toBeNull();
  expect(events.some((e) => e.type === "notice" && /Goal cleared — run stopped/.test(e.message))).toBe(true);
});

test("Esc (abort) mid-run stops the goal run; the ★ goal stays set", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-abort-"));
  const prompts: string[] = [];
  let signalStarted!: () => void;
  const started = new Promise<void>((r) => (signalStarted = r));
  const abortErr = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  const assess = assessments([{ met: true, gaps: [], reason: "irrelevant" }]);
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      signalStarted();
      // Block until the turn's signal aborts — Esc must actually cancel this turn.
      await new Promise<void>((_resolve, reject) => {
        const sig = options.abortSignal;
        if (sig?.aborted) return reject(abortErr());
        sig?.addEventListener("abort", () => reject(abortErr()), { once: true });
      });
      return textStep("unreachable") as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: {
      ...defaultConfig(),
      model: "mock/test",
      checkpoints: { enabled: false },
      goal: { maxRounds: 25, planFirst: false },
    },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "polish the readme" });
  await started;
  engine.send({ type: "abort" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // Only the (aborted) drive turn ran: no assessment, no continuation.
  expect(prompts).toHaveLength(1);
  expect(assess.calls()).toBe(0);
  // Esc pauses the run but does not clear the north star.
  expect(engine.snapshot().goal).toBe("polish the readme");
});

test("a typed prompt mid-run STEERS the goal run instead of killing it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-steer-"));
  const prompts: string[] = [];
  let releaseDrive!: () => void;
  const driveGate = new Promise<void>((r) => (releaseDrive = r));
  let signalDriveStarted!: () => void;
  const driveStarted = new Promise<void>((r) => (signalDriveStarted = r));

  const assess = assessments([
    { met: false, gaps: ["tests missing"], reason: "not yet" },
    { met: true, gaps: [], reason: "done now" },
    { met: true, gaps: [], reason: "verified" },
  ]);
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const idx = prompts.length;
      prompts.push(JSON.stringify(options.prompt));
      if (idx === 0) {
        signalDriveStarted();
        await driveGate; // hold the drive turn so the steer queues behind it
      }
      return textStep(`turn ${idx}`) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: {
      ...defaultConfig(),
      model: "mock/test",
      checkpoints: { enabled: false },
      goal: { maxRounds: 25, planFirst: false },
    },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "ship the feature" });
  await driveStarted;
  engine.send({ type: "submit-prompt", text: "steer note: prefer bun test" });
  releaseDrive();
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // Order: drive → steer (queued during the drive turn) → gap continuation →
  // adversarial verify. The steer turn did NOT kill the run, and while a
  // continuation was already queued it did NOT stack a second one (its
  // #afterTurn skipped the assessment — 3 assessments total, not 4).
  expect(prompts).toHaveLength(4);
  expect(prompts[1]).toContain("steer note: prefer bun test");
  expect(prompts[2]).toContain("tests missing");
  expect(prompts[3]).toContain("TRULY met");
  expect(assess.calls()).toBe(3);
  expect(
    events.some((e) => e.type === "notice" && /Goal met after .* verified across 2 consecutive clean passes/.test(e.message)),
  ).toBe(true);
  expect(engine.snapshot().goal).toBe("ship the feature");
});

// ---------------------------------------------------------------------------
// PLAN → EXECUTE → VERIFY pipeline (goal.planFirst, the default)
// ---------------------------------------------------------------------------

const PLAN_TEXT = "Here is the plan:\n- [ ] write the README\n- [ ] add usage docs";

test("pipeline: plan turn seeds tasks, execute turn drives them, verify converges", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-pipe-"));
  const prompts: string[] = [];
  const assess = assessments([{ met: true, gaps: [], reason: "all done" }]);
  // Steps: plan turn (checklist TEXT — no update_tasks call, exercising the
  // engine-side seeding fallback), execute turn (completes both tasks then
  // reports), verify turn.
  const steps = [
    textStep(PLAN_TEXT),
    toolCall("c1", "update_tasks", {
      updates: [
        { id: "t1", status: "completed" },
        { id: "t2", status: "completed" },
      ],
    }),
    textStep("both tasks done"),
    textStep("verified clean"),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return steps[call++] as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "document the project" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // Plan turn: planning-only directive; engine parsed its checklist into tasks.
  expect(prompts[0]).toContain("PLANNING ONLY");
  const seeded = events.find((e) => e.type === "tasks-updated");
  expect(seeded && "tasks" in seeded ? seeded.tasks.map((t) => t.title) : []).toEqual([
    "write the README",
    "add usage docs",
  ]);
  // Execute turn carries the shared task contract with the seeded ids.
  expect(prompts[1]).toContain("t1 write the README");
  expect(prompts[1]).toContain("update_tasks");
  // Verify turn is adversarial and task-aware. (The execute turn spans TWO
  // stream calls — tool-call step + finishing text — so verify is prompts[3].)
  expect(prompts[3]).toContain("TRULY met");
  expect(prompts[3]).toContain("in_progress");
  // Tasks all complete before ANY assessment ran (short-circuit never fired),
  // then met + met converge.
  expect(assess.calls()).toBe(2);
  // The Gate evidence line rides the assessment prompt.
  expect(assess.prompts[0]).toContain("Gate:");
  expect(
    events.some((e) => e.type === "notice" && /Goal met after .* tasks completed/.test(e.message)),
  ).toBe(true);
});

test("pipeline: a prose plan with no checklist falls back to a single goal task", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-fallback-"));
  const assess = assessments([{ met: true, gaps: [], reason: "done" }]);
  const steps = [
    textStep("I looked around and will just do it."), // plan turn, no checklist
    toolCall("c1", "update_tasks", { updates: [{ id: "t1", status: "completed" }] }),
    textStep("done"),
    textStep("verified"),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => steps[call++] as never,
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "tidy the docs" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // The execute loop always has a task spine: the goal itself became the task.
  const seeded = events.find((e) => e.type === "tasks-updated");
  expect(seeded && "tasks" in seeded ? seeded.tasks.map((t) => t.title) : []).toEqual(["tidy the docs"]);
  expect(events.some((e) => e.type === "notice" && /single task/.test(e.message))).toBe(true);
  expect(events.some((e) => e.type === "notice" && /Goal met after/.test(e.message))).toBe(true);
});

test("pipeline: unfinished tasks drive task continuations — no assessment until the list is done", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-layering-"));
  const prompts: string[] = [];
  const assess = assessments([{ met: true, gaps: [], reason: "done" }]);
  const steps = [
    textStep("- [ ] the one thing"), // plan
    textStep("worked on it but forgot the task list"), // execute — t1 left pending
    // task continuation: completes t1, then reports
    toolCall("c1", "update_tasks", { updates: [{ id: "t1", status: "completed" }] }),
    textStep("t1 done now"),
    textStep("verified"), // adversarial verify
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return steps[call++] as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "do the one thing" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // The execute turn left t1 pending → the INNER task loop continued it
  // (deterministic, no model assessment spent), with a round-progress notice.
  expect(prompts[2]).toContain("these tasks remain");
  expect(prompts[2]).toContain("t1 (pending): the one thing");
  expect(
    events.some((e) => e.type === "notice" && /Goal round 1\/10 — unfinished tasks: t1/.test(e.message)),
  ).toBe(true);
  // Assessments only began once the list was complete: met + met = done.
  expect(assess.calls()).toBe(2);
  expect(events.some((e) => e.type === "notice" && /Goal met after/.test(e.message))).toBe(true);
});

test("pipeline: task continuations charge the UNIFIED goal budget and exhaust with ONE warn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-unibudget-"));
  const assess = assessments([{ met: true, gaps: [], reason: "unreachable" }]);
  // Plan seeds one task; execute and every continuation never touch it.
  const steps = [textStep("- [ ] impossible thing")];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      const step = steps[call];
      call++;
      return (step ?? textStep("still working")) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: {
      ...defaultConfig(),
      model: "mock/test",
      checkpoints: { enabled: false },
      goal: { maxRounds: 2, planFirst: true },
    },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "do the impossible" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // plan + execute + exactly maxRounds(2) task continuations — the task loop's
  // rounds ARE the goal rounds (no 2×5 gate-budget multiplication).
  expect(call).toBe(4);
  // Deterministic short-circuit the whole way: no assessment was ever spent.
  expect(assess.calls()).toBe(0);
  // Exactly ONE exhaust warn (the task cap defers to the goal loop's warn).
  const warns = events.filter(
    (e) => e.type === "notice" && e.level === "warn" && /not confirmed met after 2/.test(e.message),
  );
  expect(warns).toHaveLength(1);
  expect(
    events.filter((e) => e.type === "notice" && e.level === "warn" && /Plan tasks still unfinished/.test(e.message)),
  ).toHaveLength(0);
  // ★ stays for the user to act on.
  expect(engine.snapshot().goal).toBe("do the impossible");
});

test("applyGateToVerdict: a met verdict requires a green gate", () => {
  const met = { met: true, gaps: [], reason: "looks done" };
  expect(applyGateToVerdict(met, "green")).toEqual(met);
  const red = applyGateToVerdict(met, "red");
  expect(red.met).toBe(false);
  expect(red.gaps).toContain("project checks failing (gate red)");
  const unverified = applyGateToVerdict(met, "unverified");
  expect(unverified.met).toBe(false);
  expect(unverified.gaps).toContain("project checks unverified");
  // No checks available → undefined is a free pass (check-less workspace).
  expect(applyGateToVerdict(met, undefined)).toEqual(met);
  // Checks available → undefined is unverified (cannot free-pass "met").
  const missing = applyGateToVerdict(met, undefined, { checksAvailable: true });
  expect(missing.met).toBe(false);
  expect(missing.gaps).toContain("project checks unverified");
  const notMet = { met: false, gaps: ["x"], reason: "gaps" };
  expect(applyGateToVerdict(notMet, "red")).toEqual(notMet);
  expect(applyGateToVerdict(notMet, "unverified")).toEqual(notMet);
});

test("pipeline: a live run persists to engine.json and --resume re-enters it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-resume-"));
  const assessA = assessments([{ met: false, gaps: ["keep going"], reason: "not yet" }]);
  let sawExecuteTurn!: () => void;
  const executeTurnStarted = new Promise<void>((r) => (sawExecuteTurn = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let callA = 0;
  const modelA = new MockLanguageModelV2({
    doStream: async () => {
      const idx = callA++;
      if (idx === 0) return textStep("- [ ] the work") as never; // plan
      sawExecuteTurn();
      await gate; // hold the execute turn so we can capture live-run state
      return textStep("working") as never;
    },
    doGenerate: assessA.doGenerate,
  });
  const engineA = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(modelA),
    interactive: false,
  });
  await engineA.bootstrap();
  const { done: doneA } = collect(engineA);
  engineA.send({ type: "run-slash", name: "goal", args: "finish the work" });
  await executeTurnStarted;

  // Live-run state is on disk mid-run (written when the execute phase began).
  const sessionId = engineA.snapshot().sessionId;
  const statePath = join(globalStateDir(cwd), "sessions", sessionId, "engine.json");
  let liveState: Record<string, unknown> = {};
  for (let tries = 0; tries < 100; tries++) {
    try {
      liveState = (await Bun.file(statePath).json()) as Record<string, unknown>;
      // Wait for the EXECUTE-phase write specifically: the persists are
      // fire-and-forget, so the first active read can still be the arm-time
      // write (phase "plan") with the phase-flip write in flight behind it.
      if (liveState.goalRunActive && liveState.goalPhase === "execute") break;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(liveState.goalRunActive).toBe(true);
  expect(liveState.goalPhase).toBe("execute");

  // Let engine A finish cleanly (clear ends the run and persists the disarm)…
  release();
  engineA.send({ type: "run-slash", name: "goal", args: "clear" });
  await engineA.whenIdle();
  engineA.send({ type: "shutdown" });
  await doneA;
  // …wait for A's fire-and-forget disarm write to actually land (otherwise it
  // races the restore below and clobbers it back to disarmed)…
  for (let tries = 0; tries < 100; tries++) {
    const settled = (await Bun.file(statePath)
      .json()
      .catch(() => null)) as { goalRunActive?: boolean } | null;
    if (settled && settled.goalRunActive === false) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  // …then simulate a crash by restoring the captured LIVE state file.
  await Bun.write(statePath, JSON.stringify(liveState));

  // Engine B resumes the same session: tasks already complete, so re-entry is
  // assessment-driven — met + met converges without any fresh drive/plan turn.
  const assessB = assessments([{ met: true, gaps: [], reason: "done" }]);
  const promptsB: string[] = [];
  const modelB = new MockLanguageModelV2({
    doStream: async (options) => {
      promptsB.push(JSON.stringify(options.prompt));
      return textStep("verified") as never;
    },
    doGenerate: assessB.doGenerate,
  });
  const engineB = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(modelB),
    interactive: false,
    resume: {
      meta: {
        id: sessionId,
        createdAt: 0,
        updatedAt: 0,
        model: "mock/test",
        mode: "execute",
        goal: "finish the work",
        tasks: [{ id: "task-1", title: "the work", status: "completed" }],
      },
      modelMessages: [],
      history: [],
    },
  });
  // Subscribe BEFORE bootstrap — the "Resuming goal run" notice fires there.
  const { events: eventsB, done: doneB } = collect(engineB);
  await engineB.bootstrap();
  await engineB.whenIdle();
  engineB.send({ type: "shutdown" });
  await doneB;

  expect(eventsB.some((e) => e.type === "notice" && /Resuming goal run/.test(e.message))).toBe(true);
  // Assessment-driven re-entry: one verify turn, two clean passes, done.
  expect(assessB.calls()).toBe(2);
  expect(promptsB).toHaveLength(1);
  expect(promptsB[0]).toContain("TRULY met");
  expect(eventsB.some((e) => e.type === "notice" && /Goal met after/.test(e.message))).toBe(true);
});

test("/goal from plan mode flips to execute WITHOUT hijacking a presented plan", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-planmode-"));
  const prompts: string[] = [];
  const assess = assessments([{ met: true, gaps: [], reason: "done" }]);
  const steps = [
    // Plan-mode turn: the model presents a real plan (arming #lastPlan).
    toolCall("p1", "present_plan", { plan: "1. Do the thing" }),
    textStep("plan presented"),
    // Goal run (legacy path to keep it small): drive + verify.
    textStep("did it"),
    textStep("verified"),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return steps[call++] as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: {
      ...defaultConfig(),
      model: "mock/test",
      mode: "plan",
      checkpoints: { enabled: false },
      goal: { maxRounds: 25, planFirst: false },
    },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "submit-prompt", text: "plan the thing" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "plan-presented")).toBe(true);

  engine.send({ type: "run-slash", name: "goal", args: "ship something else" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // The run flipped the mode itself (a plan-mode run could never mutate)…
  expect(engine.snapshot().mode).toBe("execute");
  expect(events.some((e) => e.type === "notice" && /requires execute mode/.test(e.message))).toBe(true);
  // …WITHOUT approving the unrelated presented plan (the set-mode command path
  // would have): no handoff notice, no approval preamble in any prompt.
  expect(events.some((e) => e.type === "notice" && /Executing the approved plan/.test(e.message))).toBe(false);
  expect(prompts.some((p) => p.includes("approved by the user"))).toBe(false);
  expect(events.some((e) => e.type === "notice" && /Goal met after/.test(e.message))).toBe(true);
});

test("pipeline: a steer folds in and the task chain re-arms after it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-steer2-"));
  const prompts: string[] = [];
  const assess = assessments([{ met: true, gaps: [], reason: "done" }]);
  let sawExecuteTurn!: () => void;
  const executeTurnStarted = new Promise<void>((r) => (sawExecuteTurn = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const steps = [
    textStep("- [ ] the task"), // plan
    textStep("started but did not finish"), // execute (held; steer queues behind) — t1 stays pending
    textStep("noted the steer"), // steer turn
    // goal continuation (short-circuit on t1): completes it
    toolCall("c1", "update_tasks", { updates: [{ id: "t1", status: "completed" }] }),
    textStep("t1 finished"),
    textStep("verified"), // adversarial verify
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const idx = call++;
      prompts.push(JSON.stringify(options.prompt));
      if (idx === 1) {
        sawExecuteTurn();
        await gate;
      }
      return steps[idx] as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "finish the task" });
  await executeTurnStarted;
  engine.send({ type: "submit-prompt", text: "steer: also check the docs" });
  release();
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // Order: plan → execute (steer disarmed the chain mid-turn) → steer turn →
  // goal continuation (the short-circuit re-armed the chain, naming t1) →
  // verify. The run survived the steer and still converged.
  expect(prompts[2]).toContain("steer: also check the docs");
  expect(prompts[3]).toContain("not yet met");
  expect(prompts[3]).toContain("t1 (pending)");
  expect(prompts[5]).toContain("TRULY met");
  expect(assess.calls()).toBe(2);
  expect(events.some((e) => e.type === "notice" && /Goal met after/.test(e.message))).toBe(true);
  expect(engine.snapshot().goal).toBe("finish the task");
});

test("pipeline: Esc pause is ANNOUNCED and /goal resume re-arms at the paused phase", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-escresume-"));
  const assess = assessments([{ met: true, gaps: [], reason: "done" }]);
  let sawExecuteTurn!: () => void;
  const executeTurnStarted = new Promise<void>((r) => (sawExecuteTurn = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const steps = [
    textStep("- [ ] the work"), // plan
    textStep("started"), // execute (held; Esc lands mid-turn)
    // post-resume continuation: completes t1
    toolCall("c1", "update_tasks", { updates: [{ id: "t1", status: "completed" }] }),
    textStep("t1 finished"),
    textStep("verified"), // adversarial verify
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      const idx = call++;
      if (idx === 1) {
        sawExecuteTurn();
        await gate;
      }
      return (steps[idx] ?? textStep("noop")) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "finish the work" });
  await executeTurnStarted;
  engine.send({ type: "abort" }); // Esc mid-execute
  release();
  await engine.whenIdle();

  // The pause is ANNOUNCED (the start notice promised "typing steers it" —
  // a silent state flip would leave the user steering a dead run)…
  expect(
    events.some((e) => e.type === "notice" && /Goal run paused by the interrupt/.test(e.message)),
  ).toBe(true);
  // …and broadcast as goal-run state for the ★ header.
  expect(
    events.some((e) => e.type === "goal-run" && !e.run.active && e.run.pausedReason === "interrupted (Esc)"),
  ).toBe(true);
  expect(engine.snapshot().goalRun?.active).toBe(false);

  // /goal resume re-arms at the EXECUTE phase (tasks survived the pause) and
  // converges — the stale interrupted flag must not re-pause the fresh run.
  engine.send({ type: "run-slash", name: "goal", args: "resume" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  expect(events.some((e) => e.type === "notice" && /Goal run resumed \(continuing/.test(e.message))).toBe(true);
  expect(events.some((e) => e.type === "notice" && /Goal met after/.test(e.message))).toBe(true);
  expect(engine.snapshot().goalRun?.met).toBe(true);
});

test("pipeline: /goal <new text> mid-run SWEEPS the old run's queued continuation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-replace-"));
  const prompts: string[] = [];
  const assess = assessments([{ met: true, gaps: [], reason: "done" }]);
  let sawExecuteTurn!: () => void;
  const executeTurnStarted = new Promise<void>((r) => (sawExecuteTurn = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const steps = [
    textStep("- [ ] task A"), // plan for goal A
    textStep("A started but unfinished"), // execute A (held; /goal B queues behind)
    textStep("- [ ] task B"), // plan for goal B
    toolCall("c1", "update_tasks", { updates: [{ id: "t1", status: "completed" }] }), // execute B
    textStep("B finished"),
    textStep("verified"), // adversarial verify for B
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const idx = call++;
      prompts.push(JSON.stringify(options.prompt));
      if (idx === 1) {
        sawExecuteTurn();
        await gate;
      }
      return (steps[idx] ?? textStep("noop")) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "ship goal A" });
  await executeTurnStarted;
  engine.send({ type: "run-slash", name: "goal", args: "ship goal B" }); // replace mid-run
  release();
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // Goal A's queued task-continuation was swept — no turn ever drove A's stale
  // task list after the replacement (the continuation prompt never ran).
  expect(prompts.some((p) => p.includes("approved plan is not finished"))).toBe(false);
  // A's unfinished task list was cleared at B's arm (the run owns the spine)…
  expect(events.some((e) => e.type === "notice" && /Cleared the pre-existing task list/.test(e.message))).toBe(true);
  // …and B ran its own clean pipeline to convergence.
  expect(engine.snapshot().goal).toBe("ship goal B");
  expect(engine.snapshot().tasks.map((t) => t.title)).toEqual(["task B"]);
  expect(events.some((e) => e.type === "notice" && /Goal met after/.test(e.message))).toBe(true);
});

test("pipeline: /clear pauses the run (swept queue) and /goal resume RE-PLANS on the clean slate", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-clear-"));
  const assess = assessments([{ met: true, gaps: [], reason: "done" }]);
  let sawExecuteTurn!: () => void;
  const executeTurnStarted = new Promise<void>((r) => (sawExecuteTurn = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const steps = [
    textStep("- [ ] the work"), // plan
    textStep("started but unfinished"), // execute (held; /clear queues behind)
    textStep("- [ ] the work again"), // re-plan after resume
    toolCall("c1", "update_tasks", { updates: [{ id: "t1", status: "completed" }] }),
    textStep("done for real"),
    textStep("verified"),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      const idx = call++;
      if (idx === 1) {
        sawExecuteTurn();
        await gate;
      }
      return (steps[idx] ?? textStep("noop")) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "finish the work" });
  await executeTurnStarted;
  engine.send({ type: "run-slash", name: "clear", args: "" }); // queued behind the held turn
  release();
  await engine.whenIdle();

  // The run paused (its queued continuation swept) instead of firing turns
  // into the wiped conversation; the ★ goal survives the clear.
  expect(events.some((e) => e.type === "notice" && /Goal run paused — conversation cleared/.test(e.message))).toBe(true);
  expect(engine.snapshot().goal).toBe("finish the work");
  expect(engine.snapshot().goalRun?.active).toBe(false);
  expect(engine.snapshot().tasks).toHaveLength(0);
  expect(assess.calls()).toBe(0); // nothing assessed a wiped slate

  // Resume re-enters at PLAN (the execute-phase task spine was wiped) and the
  // fresh pipeline converges.
  engine.send({ type: "run-slash", name: "goal", args: "resume" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  expect(events.some((e) => e.type === "notice" && /Goal run resumed \(re-planning/.test(e.message))).toBe(true);
  expect(engine.snapshot().tasks.map((t) => t.title)).toEqual(["the work again"]);
  expect(events.some((e) => e.type === "notice" && /Goal met after/.test(e.message))).toBe(true);
});

test("pipeline: checked checkboxes in the plan text are narration, not seeded tasks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-checked-"));
  const assess = assessments([{ met: true, gaps: [], reason: "done" }]);
  const steps = [
    // The model narrates its investigation with checked boxes and forgets
    // update_tasks — only the UNCHECKED step is real pending work.
    textStep("- [x] read the existing code\n- [X] confirmed the bug\n- [ ] write the fix"),
    toolCall("c1", "update_tasks", { updates: [{ id: "t1", status: "completed" }] }),
    textStep("fix written"),
    textStep("verified"),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      const idx = call++;
      return (steps[idx] ?? textStep("noop")) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "fix the bug" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  expect(engine.snapshot().tasks.map((t) => t.title)).toEqual(["write the fix"]);
  expect(events.some((e) => e.type === "notice" && /Goal met after/.test(e.message))).toBe(true);
});

test("an Esc landing DURING the self-assessment does not launch one more turn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-assessrace-"));
  let sawAssess!: () => void;
  const assessStarted = new Promise<void>((r) => (sawAssess = r));
  let releaseAssess!: () => void;
  const assessGate = new Promise<void>((r) => (releaseAssess = r));
  let streamCalls = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      streamCalls++;
      return textStep("worked on it") as never;
    },
    // A NOT-met verdict resolving AFTER the abort — acting on it would enqueue
    // a continuation the user just stopped.
    doGenerate: async () => {
      sawAssess();
      await assessGate;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ met: false, gaps: ["more"], reason: "keep going" }) }],
        finishReason: "stop" as const,
        usage: USAGE,
        warnings: [],
      };
    },
  });
  const engine = new Engine({
    config: {
      ...defaultConfig(),
      model: "mock/test",
      checkpoints: { enabled: false },
      goal: { maxRounds: 25, planFirst: false },
    },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "do the thing" });
  await assessStarted;
  engine.send({ type: "abort" }); // Esc while the assessment call is in flight
  releaseAssess();
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  expect(streamCalls).toBe(1); // the drive turn only — no post-abort continuation
  expect(events.some((e) => e.type === "notice" && /Goal round 1/.test(e.message))).toBe(false);
  expect(engine.snapshot().goalRun?.active).toBe(false);
});

test("a steer's round-budget re-grant is PERSISTED (a kill mid-steer resumes with fresh runway)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-steerpersist-"));
  const assess = assessments([
    { met: false, gaps: ["more work"], reason: "not there yet" }, // round 1
    { met: true, gaps: [], reason: "done" },
  ]);
  let sawContinuation!: () => void;
  const continuationStarted = new Promise<void>((r) => (sawContinuation = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      const idx = call++;
      if (idx === 1) {
        sawContinuation();
        await gate; // hold round 1's continuation so the steer queues behind it
      }
      return textStep(`turn ${idx} done`) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: {
      ...defaultConfig(),
      model: "mock/test",
      checkpoints: { enabled: false },
      goal: { maxRounds: 25, planFirst: false },
    },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "do the thing" });
  await continuationStarted;
  // Anchor on the ROUND-1 write first: the arm-time write is also 0, so
  // breaking on the first 0 could pass vacuously if the round-1 write were
  // still queued when the steer zeroed the in-memory counter.
  const statePath = join(globalStateDir(cwd), "sessions", engine.snapshot().sessionId, "engine.json");
  let persisted: { goalContinueRounds?: number } | null = null;
  for (let tries = 0; tries < 100; tries++) {
    persisted = (await Bun.file(statePath)
      .json()
      .catch(() => null)) as { goalContinueRounds?: number } | null;
    if (persisted?.goalContinueRounds === 1) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(persisted?.goalContinueRounds).toBe(1);
  engine.send({ type: "submit-prompt", text: "steer: focus on the docs" });

  // The re-grant lands on disk BEFORE the steer turn runs — a kill right here
  // must resume with the refreshed budget, not the pre-steer round count.
  for (let tries = 0; tries < 100; tries++) {
    persisted = (await Bun.file(statePath)
      .json()
      .catch(() => null)) as { goalContinueRounds?: number } | null;
    if (persisted && persisted.goalContinueRounds === 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(persisted?.goalContinueRounds).toBe(0);
  expect(events.some((e) => e.type === "notice" && /Steer folded into the goal run/.test(e.message))).toBe(true);

  release();
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;
  expect(events.some((e) => e.type === "notice" && /Goal met after/.test(e.message))).toBe(true);
});

test("pipeline: tasks left over from BEFORE the run never hijack its spine", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-staletasks-"));
  const prompts: string[] = [];
  const assess = assessments([{ met: true, gaps: [], reason: "done" }]);
  const steps = [
    textStep("- [ ] new goal work"), // plan (narrated only — fallback parser seeds)
    toolCall("c1", "update_tasks", { updates: [{ id: "t1", status: "completed" }] }),
    textStep("finished"),
    textStep("verified"),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const idx = call++;
      prompts.push(JSON.stringify(options.prompt));
      return (steps[idx] ?? textStep("noop")) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
    // An abandoned earlier plan left unfinished tasks in the restored session.
    resume: {
      meta: {
        id: "sess-stale",
        createdAt: 0,
        updatedAt: 0,
        model: "mock/test",
        mode: "execute",
        goal: null,
        tasks: [
          { id: "task-1", title: "old abandoned plan step", status: "pending" },
          { id: "task-2", title: "another old step", status: "in_progress" },
        ],
      },
      modelMessages: [],
      history: [],
    },
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "the new goal" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // The stale list was cleared at arm — the execute contract names ONLY the
  // fresh plan's work, and no round ever chased the abandoned steps.
  expect(events.some((e) => e.type === "notice" && /Cleared the pre-existing task list/.test(e.message))).toBe(true);
  expect(prompts.some((p) => p.includes("old abandoned plan step"))).toBe(false);
  expect(engine.snapshot().tasks.map((t) => t.title)).toEqual(["new goal work"]);
  expect(events.some((e) => e.type === "notice" && /Goal met after/.test(e.message))).toBe(true);
});

test("a gate that exhausts its fix budget STILL RED pauses the run instead of wedging it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-redgate-"));
  // A real (fast) failing check: recon detects `bun run test`, which exits 1.
  await Bun.write(
    join(cwd, "package.json"),
    JSON.stringify({ name: "fx", version: "1.0.0", scripts: { test: "echo '1 failed'; exit 1" } }),
  );
  await Bun.write(join(cwd, "bun.lock"), "");
  const assess = assessments([{ met: true, gaps: [], reason: "unreachable" }]);
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      // Every turn mutates (write) then finishes — so the gate always runs.
      const idx = call++;
      return (idx % 2 === 0
        ? toolCall(`w${idx}`, "write", { path: "out.txt", content: `gen ${idx}\n` })
        : textStep("done")) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const config = defaultConfig();
  config.model = "mock/test";
  config.checkpoints = { ...config.checkpoints, enabled: false };
  config.goal = { maxRounds: 25, planFirst: false };
  config.build.gate.maxRounds = 0; // no fix rounds: first red is terminal
  const engine = new Engine({ config, cwd, registry: mockRegistry(model), interactive: false });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "make it green" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // The run PAUSED honestly (it used to stay armed-but-idle forever, and a
  // kill+resume would resurrect it against an unverified gate).
  expect(
    events.some(
      (e) => e.type === "notice" && e.level === "warn" && /Goal run paused — the gate is still red/.test(e.message),
    ),
  ).toBe(true);
  expect(engine.snapshot().goalRun?.active).toBe(false);
  expect(engine.snapshot().goalRun?.pausedReason).toMatch(/gate stayed red/);
  expect(assess.calls()).toBe(0); // no assessment spent on a known-red tree
});

test("dequeuing the run's queued turn pauses the run instead of leaving it armed-but-stalled", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-dequeue-"));
  const assess = assessments([{ met: true, gaps: [], reason: "unreachable" }]);
  let sawExecuteTurn!: () => void;
  const executeTurnStarted = new Promise<void>((r) => (sawExecuteTurn = r));
  let releaseExecute!: () => void;
  const executeGate = new Promise<void>((r) => (releaseExecute = r));
  let sawSteerTurn!: () => void;
  const steerTurnStarted = new Promise<void>((r) => (sawSteerTurn = r));
  let releaseSteer!: () => void;
  const steerGate = new Promise<void>((r) => (releaseSteer = r));
  const steps = [
    textStep("- [ ] the work"), // plan
    textStep("started but unfinished"), // execute (held → steer queues behind)
    textStep("steer noted"), // steer turn (held → continuation sits queued)
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      const idx = call++;
      if (idx === 1) {
        sawExecuteTurn();
        await executeGate;
      }
      if (idx === 2) {
        sawSteerTurn();
        await steerGate;
      }
      return (steps[idx] ?? textStep("noop")) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "finish the work" });
  await executeTurnStarted;
  engine.send({ type: "submit-prompt", text: "steer: check the docs too" });
  releaseExecute();
  await steerTurnStarted;
  // The goal continuation is now QUEUED behind the held steer turn — find it
  // in the LATEST queue snapshot (earlier snapshots hold already-run goal
  // items whose ids are stale) and remove it, like a ✕ tap on its row.
  let queued: { id: string; label: string } | undefined;
  for (let tries = 0; tries < 100 && !queued; tries++) {
    const latest = [...events]
      .reverse()
      .find((e): e is Extract<UIEvent, { type: "queue-changed" }> => e.type === "queue-changed");
    queued = latest?.pending.find((p) => p.label.startsWith("goal: "));
    if (!queued) await new Promise((r) => setTimeout(r, 10));
  }
  expect(queued).toBeDefined();
  engine.send({ type: "dequeue", id: queued!.id });
  releaseSteer();
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // The run paused with a notice — not silently armed with nothing queued.
  expect(events.some((e) => e.type === "notice" && /its queued turn was removed/.test(e.message))).toBe(true);
  expect(engine.snapshot().goalRun?.active).toBe(false);
  expect(assess.calls()).toBe(0);
});

test("/queue clear pauses the run when it drops the run's queued turn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-queueclear-"));
  const assess = assessments([{ met: true, gaps: [], reason: "unreachable" }]);
  let sawExecuteTurn!: () => void;
  const executeTurnStarted = new Promise<void>((r) => (sawExecuteTurn = r));
  let releaseExecute!: () => void;
  const executeGate = new Promise<void>((r) => (releaseExecute = r));
  let sawSteerTurn!: () => void;
  const steerTurnStarted = new Promise<void>((r) => (sawSteerTurn = r));
  let releaseSteer!: () => void;
  const steerGate = new Promise<void>((r) => (releaseSteer = r));
  const steps = [
    textStep("- [ ] the work"), // plan
    textStep("started but unfinished"), // execute (held → steer queues behind)
    textStep("steer noted"), // steer turn (held → continuation sits queued)
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      const idx = call++;
      if (idx === 1) {
        sawExecuteTurn();
        await executeGate;
      }
      if (idx === 2) {
        sawSteerTurn();
        await steerGate;
      }
      return (steps[idx] ?? textStep("noop")) as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "finish the work" });
  await executeTurnStarted;
  engine.send({ type: "submit-prompt", text: "steer: also check the docs" });
  releaseExecute();
  await steerTurnStarted; // the goal continuation is queued behind the held steer
  engine.send({ type: "run-slash", name: "queue", args: "clear" }); // runs immediately
  releaseSteer();
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // /queue clear dropped the run's next turn → announced pause, not a silent
  // armed-but-idle wedge that an unrelated later prompt would revive.
  expect(events.some((e) => e.type === "notice" && /Goal run paused — the queue was cleared/.test(e.message))).toBe(
    true,
  );
  expect(engine.snapshot().goalRun?.active).toBe(false);
  expect(assess.calls()).toBe(0);
});

test("a hook-denied goal turn pauses the run; a denied PLAN turn never fabricates an execute spine", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-hookdeny-"));
  const assess = assessments([{ met: true, gaps: [], reason: "unreachable" }]);
  let streamCalls = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      streamCalls++;
      return textStep("should never run") as never;
    },
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);
  // Deny every goal-run directive (they all carry the north-star phrasing).
  engine.hooks.on("user.prompt.submit", (p) =>
    /north-star/.test(p.text) ? { ...p, deny: true } : p,
  );

  engine.send({ type: "run-slash", name: "goal", args: "do the blocked thing" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  // No model turn ever ran, the run paused with the hook named as the reason,
  // and the denied plan turn did NOT march into execute on a fabricated task.
  expect(streamCalls).toBe(0);
  expect(
    events.some((e) => e.type === "notice" && /Goal run paused — a prompt hook blocked the turn/.test(e.message)),
  ).toBe(true);
  expect(engine.snapshot().goalRun?.active).toBe(false);
  expect(engine.snapshot().tasks).toHaveLength(0);
  expect(events.some((e) => e.type === "notice" && /single task/.test(e.message))).toBe(false);
});

test("switching to plan mode mid-goal-run pauses the run (no read-only continuation rounds)", async () => {
  // #ensureExecuteModeForGoal only runs at start/resume, so a mid-run Shift+Tab
  // to plan would make every goal continuation a read-only plan turn — burning
  // the whole round budget on deterministic not-met rounds. The set-mode handler
  // now pauses the run instead (resume re-ensures execute).
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-planflip-"));
  const assess = assessments([{ met: false, gaps: ["more"], reason: "not done" }]);
  const model = new MockLanguageModelV2({
    doStream: async () => textStep("done") as never,
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", goal: { maxRounds: 25, planFirst: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "do the thing" });
  // Shift+Tab to plan mode while the run is active.
  engine.send({ type: "set-mode", mode: "plan" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  expect(
    events.some((e) => e.type === "notice" && /Goal run paused — switched to plan mode/.test(e.message)),
  ).toBe(true);
  expect(engine.snapshot().goalRun?.active).toBe(false);
  // The ★ goal stays set — a pause, not a clear.
  expect(engine.snapshot().goal).toBe("do the thing");
});

test("a resolve-plan accept during an active goal run cannot reseed the task spine", async () => {
  // The goal run owns the task list. A scripted/leftover plan-card accept must
  // not #seedTasksFromPlan over it and enqueue a competing execute-plan driver.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-goal-planaccept-"));
  const assess = assessments([{ met: false, gaps: ["more"], reason: "not done" }]);
  const model = new MockLanguageModelV2({
    doStream: async () => textStep("done") as never,
    doGenerate: assess.doGenerate,
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", goal: { maxRounds: 25, planFirst: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const { events, done } = collect(engine);

  engine.send({ type: "run-slash", name: "goal", args: "ship it" });
  // A plan-card accept lands while the run is active — must be refused.
  engine.send({ type: "resolve-plan", decision: "accept" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await done;

  expect(
    events.some((e) => e.type === "notice" && /A goal run owns the task list/.test(e.message)),
  ).toBe(true);
});
