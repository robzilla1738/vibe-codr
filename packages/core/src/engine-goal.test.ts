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
    events.some((e) => e.type === "notice" && /Goal round 1\/25 — unfinished tasks: t1/.test(e.message)),
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
    doStream: async () => (steps[call] ? (steps[call++] as never) : (call++, textStep("still working") as never)),
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

test("applyGateToVerdict: a met verdict can never stand on a red gate", () => {
  const met = { met: true, gaps: [], reason: "looks done" };
  expect(applyGateToVerdict(met, "green")).toEqual(met);
  expect(applyGateToVerdict(met, undefined)).toEqual(met);
  const overridden = applyGateToVerdict(met, "red");
  expect(overridden.met).toBe(false);
  expect(overridden.gaps).toContain("project checks failing (gate red)");
  const notMet = { met: false, gaps: ["x"], reason: "gaps" };
  expect(applyGateToVerdict(notMet, "red")).toEqual(notMet);
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
  for (let tries = 0; tries < 50; tries++) {
    try {
      liveState = (await Bun.file(statePath).json()) as Record<string, unknown>;
      if (liveState.goalRunActive) break;
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
