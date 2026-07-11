import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig } from "@vibe/config";
import type { UIEvent } from "@vibe/shared";
import { Engine } from "./engine.ts";
import { globalStateDir } from "./state-dir.ts";

// Saved plans + engine state live under VIBE_STATE_DIR — pin it to a temp dir so
// the handoff-deny test can inspect the persisted plan file hermetically.
process.env.VIBE_STATE_DIR ??= mkdtempSync(join(tmpdir(), "vibe-state-"));

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

/** A text-only model (no mutations → no gate/verify), capturing every prompt it
 * receives so the number of turns the engine drove is observable. */
function textModel() {
  const prompts: string[] = [];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textStep("done") as never;
    },
  });
  return { model, prompts };
}

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

async function makeEngine(
  model: MockLanguageModelV2,
): Promise<{ engine: Engine; events: UIEvent[]; collector: Promise<void> }> {
  const config = defaultConfig();
  config.model = "mock/test";
  // Keep turns minimal: a plain text turn is never gateable, and disabling
  // checkpoints avoids a git snapshot on the throwaway temp dir.
  config.checkpoints.enabled = false;
  const dir = mkdtempSync(join(tmpdir(), "vibe-hookfb-"));
  const engine = new Engine({
    config,
    cwd: dir,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  // Collect until the stream ends (on shutdown) so buffered events — engine-idle
  // and late notices — are all delivered before the test asserts on them.
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  return { engine, events, collector };
}

/** A model whose FIRST turn cancels itself: it aborts the live turn through the
 * engine, then yields the abort a tick to land before returning a stream — so the
 * turn's aborted signal makes the session mark itself `interrupted` (the real Esc
 * path). Later turns answer normally. Lets a test observe whether the engine
 * wrongly injects a follow-up turn after an aborted one. */
function selfAbortingModel() {
  const prompts: string[] = [];
  let calls = 0;
  let engine: Engine | undefined;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      calls += 1;
      if (calls === 1) {
        engine!.send({ type: "abort" });
        // Let the abort message process (aborting the turn's signal) before the
        // stream is consumed, so streamText cancels and the turn is interrupted.
        await new Promise((r) => setTimeout(r, 0));
      }
      return textStep("done") as never;
    },
  });
  return { model, prompts, bind: (e: Engine) => (engine = e) };
}

const idleEvents = (events: UIEvent[]) => events.filter((e) => e.type === "engine-idle");
const warnNotices = (events: UIEvent[]) =>
  events.filter(
    (e): e is Extract<UIEvent, { type: "notice" }> => e.type === "notice" && e.level === "warn",
  );

test("session.idle continue hook forces one follow-up turn then settles idle", async () => {
  const { model, prompts } = textModel();
  const { engine, events, collector } = await makeEngine(model);
  let fired = 0;
  engine.hooks.on("session.idle", (p) => {
    fired += 1;
    // Ask to continue exactly once; the second drain settles idle.
    return fired === 1 ? { ...p, continue: true, reason: "finish the remaining work" } : p;
  });

  engine.send({ type: "submit-prompt", text: "start" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // Initial turn + exactly ONE synthetic continuation.
  expect(prompts).toHaveLength(2);
  // The continuation prompt was built from the hook's `reason`.
  expect(prompts[1]).toContain("finish the remaining work");
  // engine-idle STILL fires (the terminal signal is never skipped).
  expect(idleEvents(events).length).toBeGreaterThanOrEqual(1);
});

test("session.idle continue budget caps an always-continue hook at 3 with a warn notice", async () => {
  const { model, prompts } = textModel();
  const { engine, events, collector } = await makeEngine(model);
  engine.hooks.on("session.idle", (p) => ({ ...p, continue: true, reason: "again" }));

  engine.send({ type: "submit-prompt", text: "start" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // Initial turn + 3 bounded continuations — never more, however insistent the hook.
  expect(prompts).toHaveLength(4);
  // The budget-exhausted warning was surfaced, and idle still settled.
  expect(warnNotices(events).some((n) => n.message.includes("budget"))).toBe(true);
  expect(idleEvents(events).length).toBeGreaterThanOrEqual(1);
});

test("engine-idle still fires with a throwing session.idle hook", async () => {
  const { model, prompts } = textModel();
  const { engine, events, collector } = await makeEngine(model);
  engine.hooks.on("session.idle", () => {
    throw new Error("hook blew up");
  });

  engine.send({ type: "submit-prompt", text: "start" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // A throwing idle hook yields no continue directive → no extra turns, and the
  // HookBus isolation keeps the queue from wedging.
  expect(prompts).toHaveLength(1);
  expect(idleEvents(events).length).toBeGreaterThanOrEqual(1);
});

test("an aborted turn is NOT resurrected by a session.idle continue hook", async () => {
  // Regression: #maybeContinueOnIdle ran the session.idle hook and injected a
  // follow-up turn even after the user Esc-aborted (or a cost-budget stop) — the
  // guard that skips task-continuation on interruption was missing here, so a
  // {continue:true} hook resurrected a turn the user had just cancelled.
  const { model, prompts, bind } = selfAbortingModel();
  const { engine, events, collector } = await makeEngine(model);
  bind(engine);
  let fired = 0;
  engine.hooks.on("session.idle", (p) => {
    fired += 1;
    return { ...p, continue: true, reason: "keep going" };
  });

  engine.send({ type: "submit-prompt", text: "start" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // Only the single (aborted) turn ran — the interrupted guard settles idle
  // BEFORE the hook is even consulted, so no continuation was injected.
  expect(prompts).toHaveLength(1);
  expect(fired).toBe(0);
  // The terminal engine-idle signal still fires.
  expect(idleEvents(events).length).toBeGreaterThanOrEqual(1);
});

test("the idle-continue budget resets on each real user prompt", async () => {
  const { model, prompts } = textModel();
  const { engine, events, collector } = await makeEngine(model);
  // Continue once per user prompt (fires on the first drain after each submit).
  const seenThisPrompt = new Set<number>();
  let promptEpoch = 0;
  engine.hooks.on("session.idle", (p) => {
    if (!seenThisPrompt.has(promptEpoch)) {
      seenThisPrompt.add(promptEpoch);
      return { ...p, continue: true, reason: "one more" };
    }
    return p;
  });

  engine.send({ type: "submit-prompt", text: "first" });
  await engine.whenIdle();
  promptEpoch = 1;
  engine.send({ type: "submit-prompt", text: "second" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // Each user prompt drove initial + one continuation = 2 turns; the budget reset
  // between them means the second prompt could continue afresh (not blocked by
  // the first prompt's spent round). 2 prompts × 2 turns = 4.
  expect(prompts).toHaveLength(4);
  expect(idleEvents(events).length).toBeGreaterThanOrEqual(2);
});

// ─────────────────────── user.prompt.submit deny ordering (FIX 2) ───────────

function gitInit(dir: string): void {
  const run = (args: string[]) => spawnSync("git", args, { cwd: dir, stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t.dev"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  run(["add", "-A"]);
  run(["commit", "-qm", "init"]);
}

test("a prompt denied by a user.prompt.submit hook seeds NO checkpoint (deny runs before the snapshot)", async () => {
  // Regression: the checkpoint snapshot + checkpoint-created emit used to run
  // BEFORE the deny check, so a blocked prompt still seeded a no-op checkpoint.
  // The hook now runs FIRST — a denied prompt mutates nothing.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-hookcp-"));
  gitInit(cwd);
  const { model, prompts } = textModel();
  const config = defaultConfig();
  config.model = "mock/test";
  config.checkpoints.enabled = true; // execute mode + git repo → snapshot is real
  config.build.enabled = false; // keep the turn lean (no recon/gate)
  const engine = new Engine({ config, cwd, registry: mockRegistry(model), interactive: false });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  engine.hooks.on("user.prompt.submit", (p) =>
    p.text.startsWith("block") ? { ...p, deny: true } : p,
  );

  // A normal prompt DOES take a checkpoint (proves the harness can produce one).
  engine.send({ type: "submit-prompt", text: "allow this" });
  await engine.whenIdle();
  const cpAfterAllow = events.filter((e) => e.type === "checkpoint-created").length;
  expect(cpAfterAllow).toBeGreaterThanOrEqual(1);

  // A denied prompt takes NONE — no new checkpoint-created, and it never runs.
  engine.send({ type: "submit-prompt", text: "block this" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  expect(events.filter((e) => e.type === "checkpoint-created").length).toBe(cpAfterAllow);
  expect(prompts).toHaveLength(1); // only the allowed prompt reached the model
  expect(warnNotices(events).some((n) => n.message.includes("Prompt blocked"))).toBe(true);
});

/** A present_plan tool step + a trailing text step. */
const presentPlanStep = (plan: string) =>
  stream([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "p1",
      toolName: "present_plan",
      input: JSON.stringify({ plan }),
    },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]);

/** Does a persisted plan file survive under this cwd's state dir? */
function planFileExists(cwd: string): boolean {
  try {
    return readdirSync(join(globalStateDir(cwd), "plans")).some((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
}

test("a handoff denied by a user.prompt.submit hook keeps the approved plan intact (a later handoff still works)", async () => {
  // Regression: the handoff block cleared #lastPlan and DISCARDED the persisted
  // plan file BEFORE the deny check, so a denied handoff permanently deleted the
  // approved plan with zero turns run. The hook now runs FIRST — a denied handoff
  // leaves the plan on disk so /execute can hand off again; an allowed handoff
  // consumes it exactly as before.
  async function run(denyHandoff: boolean): Promise<boolean> {
    const cwd = mkdtempSync(join(tmpdir(), "vibe-hookplan-"));
    // Two steps + a verification cue so the plan-gate structure contract
    // accepts the present (empty tmpdir is greenfield, so needsCode reads are waived).
    const steps = [
      presentPlanStep("# Plan\n1. do the thing\n2. verify with tests"),
      textStep("Plan ready."),
      textStep("Executing."),
    ];
    let call = 0;
    const model = new MockLanguageModelV2({
      doStream: async () => (steps[call++] ?? textStep("done")) as never,
    });
    const config = defaultConfig();
    config.model = "mock/test";
    config.mode = "plan";
    config.checkpoints.enabled = false;
    // Leave build/recon ON: recon marks the empty temp dir greenfield, so the
    // plan-grounding gate lets a plain "plan a refactor" present without research.
    const engine = new Engine({ config, cwd, registry: mockRegistry(model), interactive: false });
    await engine.bootstrap();
    const collector = (async () => {
      for await (const _ of engine.events()) void _;
    })();
    // Deny ONLY the internal handoff kickoff, never the planning prompt.
    engine.hooks.on("user.prompt.submit", (p) =>
      denyHandoff && p.text.startsWith("Proceed with the approved plan") ? { ...p, deny: true } : p,
    );

    engine.send({ type: "submit-prompt", text: "plan a refactor" });
    await engine.whenIdle();
    engine.send({ type: "resolve-plan", decision: "accept" }); // fires the handoff
    await engine.whenIdle();
    engine.send({ type: "shutdown" });
    await collector;
    return planFileExists(cwd);
  }

  // Denied handoff → the persisted plan is preserved (not discarded).
  expect(await run(true)).toBe(true);
  // Allowed handoff → the handoff consumes + discards the plan, exactly as before.
  expect(await run(false)).toBe(false);
});
