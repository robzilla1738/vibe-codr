import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig } from "@vibe/config";
import type { UIEvent } from "@vibe/shared";
import { Engine } from "./engine.ts";
import { globalStateDir } from "./state-dir.ts";

// Machine state (persisted plans, sessions) lives in the per-project GLOBAL
// state dir — point it at a temp root so tests never touch ~/.vibe/state.
process.env.VIBE_STATE_DIR ??= mkdtempSync(join(tmpdir(), "vibe-state-"));

function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({
      chunks: chunks as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}
const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function mockRegistry(model: MockLanguageModelV2): ProviderRegistry {
  return new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
}

// A real end-to-end pass through the top-level Engine: submit a prompt, let the
// (mock) model call the REAL `read` builtin against a real file, feed the result
// back, and produce final text — the exact path `vibecodr -p "..."` drives, but
// deterministic so it needs no API key.
test("Engine: prompt -> real read builtin -> tool result -> final text", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-e2e-"));
  writeFileSync(join(cwd, "secret.txt"), "the answer is 42\n");

  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read",
        input: JSON.stringify({ path: "secret.txt" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "The file says the answer is 42." },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });

  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test" },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();

  const events: UIEvent[] = [];
  const sub = engine.events();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  engine.send({ type: "submit-prompt", text: "what is in secret.txt?" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // Both model turns ran (tool-call turn, then final-text turn).
  expect(call).toBe(2);

  // The REAL read tool ran and returned the file's contents.
  const toolDone = events.find((e) => e.type === "tool-call-finished");
  expect(toolDone && toolDone.type === "tool-call-finished" && toolDone.toolName).toBe("read");
  expect(
    toolDone && toolDone.type === "tool-call-finished" && String(toolDone.output),
  ).toContain("the answer is 42");

  // The streamed final answer is correct and the turn completed.
  const text = events
    .filter((e): e is Extract<UIEvent, { type: "assistant-text-delta" }> => e.type === "assistant-text-delta")
    .map((e) => e.delta)
    .join("");
  expect(text).toBe("The file says the answer is 42.");
  expect(events.some((e) => e.type === "turn-finished")).toBe(true);
});

test("Engine planning: present_plan persists the plan + plan→execute injects a handoff", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-plan-"));
  const prompts: string[] = [];
  const steps = [
    // Plan turn: the model presents a plan.
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "p1",
        toolName: "present_plan",
        input: JSON.stringify({ plan: "1. Refactor the loader\n2. Add tests" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Plan presented." },
      { type: "text-end", id: "a" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
    // Execute turn (after approval): capture the prompt the model receives.
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "b", delta: "Implementing the plan." },
      { type: "text-end", id: "b" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return steps[call++] as never;
    },
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", mode: "plan" },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const sub = engine.events();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  engine.send({ type: "submit-prompt", text: "plan a refactor" });
  await engine.whenIdle();
  // The plan was presented and persisted to the global state dir's plans/.
  expect(events.some((e) => e.type === "plan-presented")).toBe(true);
  const sessionId = engine.snapshot().sessionId;
  const planFile = await Bun.file(join(globalStateDir(cwd), "plans", `${sessionId}.md`)).text();
  expect(planFile).toContain("Refactor the loader");

  // Approve: /execute-style start:true begins the handoff turn immediately.
  engine.send({ type: "set-mode", mode: "execute", start: true });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  expect(prompts.at(-1)).toContain("approved by the user");
  expect(
    events.some(
      (e) => e.type === "notice" && "message" in e && e.message.includes("Executing the approved plan"),
    ),
  ).toBe(true);

  // Once the handoff is consumed the persisted plan is DISCARDED, so a later
  // --resume can't reload it into #lastPlan and re-fire the already-executed
  // plan's handoff (silently re-running finished work).
  let planStillThere = true;
  try {
    await Bun.file(join(globalStateDir(cwd), "plans", `${sessionId}.md`)).text();
  } catch {
    planStillThere = false;
  }
  expect(planStillThere).toBe(false);
});

test("Engine planning: resolve-plan accept switches to execute, seeds tasks, runs the handoff", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-plan-accept-"));
  const prompts: string[] = [];
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "p1",
        toolName: "present_plan",
        input: JSON.stringify({ plan: "## Steps\n- [ ] Refactor the loader\n- [ ] Add tests" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Plan presented." },
      { type: "text-end", id: "a" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "b", delta: "Implementing the plan." },
      { type: "text-end", id: "b" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return steps[call++] as never;
    },
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", mode: "plan" },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();

  engine.send({ type: "submit-prompt", text: "plan a refactor" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "plan-presented")).toBe(true);

  engine.send({ type: "resolve-plan", decision: "accept" });
  await engine.whenIdle();

  // Tasks seeded from the plan's checklist.
  const tasks = events.filter((e) => e.type === "tasks-updated").at(-1);
  expect(tasks && "tasks" in tasks ? tasks.tasks.map((t) => t.title) : []).toEqual([
    "Refactor the loader",
    "Add tests",
  ]);
  // Switched to execute and ran the turn with the approval handoff — which
  // names the seeded tasks BY ID with the update contract, so execution flips
  // statuses live instead of sitting at 0/N.
  expect(events.some((e) => e.type === "mode-changed" && e.mode === "execute")).toBe(true);
  expect(prompts.at(-1)).toContain("approved by the user");
  expect(prompts.at(-1)).toContain("t1 Refactor the loader");
  expect(prompts.at(-1)).toContain("t2 Add tests");
  expect(prompts.at(-1)).toContain("update_tasks");
  // The internal handoff directive goes to the MODEL but must NOT render as a user
  // message the user "sent" — instead a clean "Executing the approved plan…" notice.
  const userMsgs = events.filter((e) => e.type === "user-message" && "text" in e) as {
    text: string;
  }[];
  expect(userMsgs.some((e) => e.text.includes("approved by the user"))).toBe(false);
  expect(
    events.some((e) => e.type === "notice" && "message" in e && e.message.includes("Executing the approved plan")),
  ).toBe(true);

  engine.send({ type: "shutdown" });
  await collector;
});

// Seed the task list from a plan and return the resulting titles + whether a
// truncation notice fired — the shared harness for the two #seedTasksFromPlan
// regressions below.
async function seedPlanTasks(plan: string): Promise<{ titles: string[]; truncated: boolean }> {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-seed-"));
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "p1", toolName: "present_plan", input: JSON.stringify({ plan }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Plan presented." },
      { type: "text-end", id: "a" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "b", delta: "Implementing." },
      { type: "text-end", id: "b" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", mode: "plan" },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  engine.send({ type: "submit-prompt", text: "plan it" });
  await engine.whenIdle();
  engine.send({ type: "resolve-plan", decision: "accept" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;
  const tasks = events.filter((e) => e.type === "tasks-updated").at(-1);
  const titles = tasks && "tasks" in tasks ? tasks.tasks.map((t) => t.title) : [];
  const truncated = events.some(
    (e) => e.type === "notice" && "message" in e && e.message.includes("task list capped"),
  );
  return { titles, truncated };
}

test("Engine planning: a plan longer than the cap seeds a catch-all as the last task", async () => {
  // A 15-step plan can't fit the 12-task cap; dropping the tail would let
  // #maybeContinueTasks declare the plan done once the seeded steps complete.
  // Instead: first 11 real steps + one catch-all tracking the remainder.
  const plan = `## Steps\n${Array.from({ length: 15 }, (_, i) => `- [ ] Step ${i + 1}`).join("\n")}`;
  const { titles, truncated } = await seedPlanTasks(plan);
  expect(titles.length).toBe(12);
  expect(titles.slice(0, 11)).toEqual(Array.from({ length: 11 }, (_, i) => `Step ${i + 1}`));
  expect(titles.at(-1)).toBe("Complete the remaining 4 plan steps (see the full plan)");
  expect(truncated).toBe(true);
});

test("Engine planning: nested sub-bullets don't displace top-level plan steps", async () => {
  // Deeply-indented sub-bullets are detail, not top-level steps; an unbounded
  // indent used to fold them into the list and (under the cap) evict real steps.
  const plan = [
    "## Steps",
    "- [ ] Top A",
    "        - [ ] nested a1",
    "        - [ ] nested a2",
    "- [ ] Top B",
    "        - [ ] nested b1",
    "- [ ] Top C",
  ].join("\n");
  const { titles } = await seedPlanTasks(plan);
  expect(titles).toEqual(["Top A", "Top B", "Top C"]);
});

test("Engine planning: accept with approvals:'auto' (the plan card's ^Y) launches yolo execution", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-plan-yolo-"));
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "p1",
        toolName: "present_plan",
        input: JSON.stringify({ plan: "- [ ] Do the thing" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Plan presented." },
      { type: "text-end", id: "a" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "b", delta: "Doing it." },
      { type: "text-end", id: "b" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const engine = new Engine({
    // Gated ask baseline — the override alone must produce yolo execution.
    config: { ...defaultConfig(), model: "mock/test", mode: "plan", approvalMode: "ask" },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const collector = (async () => {
    for await (const _ of engine.events()) void _;
  })();

  engine.send({ type: "submit-prompt", text: "plan the thing" });
  await engine.whenIdle();
  engine.send({ type: "resolve-plan", decision: "accept", approvals: "auto" });
  await engine.whenIdle();

  expect(engine.snapshot().mode).toBe("execute");
  expect(engine.snapshot().approvalMode).toBe("auto");

  engine.send({ type: "shutdown" });
  await collector;
});

test("Engine planning: a prompt queued ahead of plan-accept can't steal the handoff", async () => {
  // Regression: the plan→execute handoff preamble used to be a shared boolean read
  // at turn-run time, so a user prompt queued before the accept would consume it
  // and the real execute-plan turn would lose it. It must now be bound to its job.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-handoff-steal-"));
  const prompts: string[] = [];
  let releaseHolder!: () => void;
  const holderGate = new Promise<void>((r) => (releaseHolder = r));

  const planStep = () =>
    stream([
      { type: "stream-start", warnings: [] },
      // Prose plan (no checklist/numbered items) → no tasks seeded, so this test
      // stays focused on handoff BINDING without the plan-task continuation loop.
      { type: "tool-call", toolCallId: "p1", toolName: "present_plan", input: JSON.stringify({ plan: "Do the thing." }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]);
  const textStep = (t: string) =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: t },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]);
  // Calls: 0 present_plan, 1 plan-text, 2 HOLDER (blocks), 3 typed-ahead A, 4 execute-plan B.
  const steps = [planStep(), textStep("planned"), textStep("holding"), textStep("A ran"), textStep("B ran")];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const idx = call++;
      prompts.push(JSON.stringify(options.prompt));
      if (idx === 2) await holderGate; // keep the drain busy so A stays queued
      return steps[idx] as never;
    },
  });

  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", mode: "plan", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();

  // Self-contained prompt (no needsCode/web/versions) so a thin present_plan
  // still presents — this test is about handoff BINDING, not the plan gate.
  engine.send({ type: "submit-prompt", text: "plan a limerick about shipping" });
  await engine.whenIdle(); // plan presented, #lastPlan set

  engine.send({ type: "submit-prompt", text: "holder turn" }); // occupies the drain (blocks on gate)
  await new Promise((r) => setTimeout(r, 10)); // let the holder's model call start
  engine.send({ type: "submit-prompt", text: "typed ahead A" }); // queued behind the holder
  engine.send({ type: "resolve-plan", decision: "accept" }); // enqueues the execute-plan turn behind A
  releaseHolder();
  await engine.whenIdle();

  engine.send({ type: "shutdown" });
  await collector;

  // Exactly one turn carries the approval preamble — and it's the execute-plan
  // turn (which also carries "Proceed with the approved plan."), NOT the A turn.
  const withHandoff = prompts.filter((p) => p.includes("approved by the user"));
  expect(withHandoff).toHaveLength(1);
  expect(withHandoff[0]).toContain("Proceed with the approved plan");
  const aPrompt = prompts.find((p) => p.includes("typed ahead A"));
  expect(aPrompt).toBeDefined();
  expect(aPrompt).not.toContain("approved by the user");
});

test("abort during a loop iteration interrupts the loop's session (not just the main one)", async () => {
  // Regression: `abort`/`steer` used to call this.#session.abort(), but a loop
  // iteration runs on the ephemeral #loopSession — so Esc couldn't interrupt it.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-loopabort-"));
  let signalStarted!: () => void;
  const started = new Promise<void>((r) => (signalStarted = r));
  const abortErr = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      // Announce the model call began, then block until the turn's signal aborts.
      // If abort never reaches THIS session's signal, the turn hangs forever.
      signalStarted();
      await new Promise<void>((_resolve, reject) => {
        const sig = options.abortSignal;
        if (sig?.aborted) return reject(abortErr());
        sig?.addEventListener("abort", () => reject(abortErr()), { once: true });
      });
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "SHOULD_NOT_APPEAR" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never;
    },
  });

  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();

  // A 1h interval + max 1 so exactly one iteration runs (and it blocks in doStream).
  engine.send({ type: "run-slash", name: "loop", args: "1h keep improving --max 1" });
  await started; // the loop iteration's model call is now blocked on its own signal
  engine.send({ type: "abort" }); // must abort the LOOP session's turn, unblocking it
  await engine.whenIdle(); // resolves only if the blocked turn was actually aborted

  engine.send({ type: "shutdown" });
  await collector;

  // The turn never completed its stream (the gate was never released), and the
  // loop stopped after its single interrupted iteration.
  const deltas = events.filter((e) => e.type === "assistant-text-delta");
  expect(deltas.some((e) => e.type === "assistant-text-delta" && e.delta.includes("SHOULD_NOT_APPEAR"))).toBe(false);
});

test("loop iterations reuse the main session context", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-loopctx-"));
  const prompts: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      call += 1;
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        {
          type: "text-delta",
          id: "t",
          delta: call === 1 ? "MEMORY_MARKER_ALPHA" : "loop saw context",
        },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never;
    },
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const collector = (async () => {
    for await (const _e of engine.events()) {
      /* drain */
    }
  })();

  engine.send({ type: "submit-prompt", text: "remember this" });
  await engine.whenIdle();
  engine.send({ type: "run-slash", name: "loop", args: "1h use prior context --max 1" });
  await engine.whenIdle();

  engine.send({ type: "shutdown" });
  await collector;

  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("MEMORY_MARKER_ALPHA");
});

test("Engine /clear emits exactly one 'Conversation cleared.' notice", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-clear-"));
  const model = new MockLanguageModelV2({ doStream: async () => stream([]) });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test" },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();

  engine.send({ type: "run-slash", name: "clear", args: "" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  const cleared = events.filter(
    (e) => e.type === "notice" && "message" in e && e.message === "Conversation cleared.",
  );
  expect(cleared).toHaveLength(1);
});

test("Engine planning: resolve-plan edit re-plans with feedback; keep-planning stays put", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-plan-edit-"));
  const prompts: string[] = [];
  const planStep = () =>
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: `p${prompts.length}`,
        toolName: "present_plan",
        input: JSON.stringify({ plan: "1. Do the thing" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]);
  const textStep = (t: string) =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "x" },
      { type: "text-delta", id: "x", delta: t },
      { type: "text-end", id: "x" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]);
  const steps = [planStep(), textStep("first plan"), planStep(), textStep("revised plan")];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return steps[call++] as never;
    },
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", mode: "plan" },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();

  engine.send({ type: "submit-prompt", text: "plan it" });
  await engine.whenIdle();

  // edit → re-plan with the feedback as the prompt; mode stays plan.
  engine.send({ type: "resolve-plan", decision: "edit", edit: "also handle the error case" });
  await engine.whenIdle();
  expect(prompts.at(-1)).toContain("also handle the error case");
  expect(prompts.at(-1)).not.toContain("approved by the user"); // not a handoff

  const callsBefore = call;
  // keep-planning → dismiss with a notice, no new model turn.
  engine.send({ type: "resolve-plan", decision: "keep-planning" });
  await engine.whenIdle();
  await new Promise((r) => setTimeout(r, 10)); // let the async collector flush the notice
  expect(call).toBe(callsBefore); // the model wasn't invoked again
  expect(events.some((e) => e.type === "notice" && /kept planning/i.test(e.message))).toBe(true);

  engine.send({ type: "shutdown" });
  await collector;
});

test("Engine: a fresh top-level prompt clears the blackboard (turn-1 note gone in turn 2)", async () => {
  // Regression: the blackboard was created once per engine and never cleared, so a
  // stale coordination note ("taking auth.ts") from an early turn leaked into an
  // unrelated fan-out many turns later. Each user-submitted prompt must start a
  // fresh coordination context. (post_note/read_notes are offered at depth 0
  // because subagents are available — maxDepth 3 > 0.)
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-board-reset-"));
  const toolCall = (id: string, name: string, input: unknown) =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]);
  const textStep = (t: string) =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: t },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]);
  const steps = [
    // Turn 1: post a claim, then read the board back (should show the claim), then finish.
    toolCall("c1", "post_note", { note: "taking auth.ts", kind: "claim" }),
    toolCall("c2", "read_notes", {}),
    textStep("turn one done"),
    // Turn 2: just read the board — it must be empty (cleared at submit).
    toolCall("c3", "read_notes", {}),
    textStep("turn two done"),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });

  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", checkpoints: { enabled: false } },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();

  engine.send({ type: "submit-prompt", text: "turn one" });
  await engine.whenIdle();
  engine.send({ type: "submit-prompt", text: "turn two" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  const reads = events
    .filter(
      (e): e is Extract<UIEvent, { type: "tool-call-finished" }> =>
        e.type === "tool-call-finished" && e.toolName === "read_notes",
    )
    .map((e) => String(e.output));
  expect(reads).toHaveLength(2);
  // Turn 1's read_notes sees the claim (with its kind tag rendered).
  expect(reads[0]).toContain("taking auth.ts");
  expect(reads[0]).toContain("[CLAIM]");
  // Turn 2 started a fresh coordination context — the turn-1 note is gone.
  expect(reads[1]).toContain("No shared notes yet.");
  expect(reads[1]).not.toContain("taking auth.ts");
});

// Regression: the /skills menu used to prefill the bare `/<name>`, which
// built-ins and custom commands shadow — a skill named `review`/`init`/`verify`
// was uninvokable from its own menu (it ran the built-in instead). The explicit
// `/skill <name> [task]` spelling must always resolve the SKILL, and must reach
// a skill whose name contains a space (longest-name-prefix match).
test("/skill invokes a skill even when a built-in shadows its bare name", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-skill-"));
  mkdirSync(join(cwd, ".vibe", "skills", "review"), { recursive: true });
  writeFileSync(
    join(cwd, ".vibe", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Team review checklist\n---\nFollow the team review checklist.",
  );
  mkdirSync(join(cwd, ".vibe", "skills", "release notes"), { recursive: true });
  writeFileSync(
    join(cwd, ".vibe", "skills", "release notes", "SKILL.md"),
    "---\nname: release notes\ndescription: Draft release notes\n---\nDraft the release notes.",
  );

  const prompts: string[] = [];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "ok" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never;
    },
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test" },
    cwd,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const sub = engine.events();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  // The builtin-shadowed name reaches the SKILL via /skill, task text included.
  engine.send({ type: "run-slash", name: "skill", args: "review the auth diff" });
  await engine.whenIdle();
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("Follow the team review checklist.");
  expect(prompts[0]).toContain("Task: the auth diff");

  // A space-containing skill name resolves by longest-name-prefix match.
  engine.send({ type: "run-slash", name: "skill", args: "release notes for v2" });
  await engine.whenIdle();
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("Draft the release notes.");
  expect(prompts[1]).toContain("Task: for v2");

  // Unknown skill: an honest warn, no model turn.
  engine.send({ type: "run-slash", name: "skill", args: "nonexistent thing" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;
  expect(prompts).toHaveLength(2);
  expect(
    events.some(
      (e) => e.type === "notice" && e.level === "warn" && e.message.includes('No skill named "nonexistent"'),
    ),
  ).toBe(true);
});
