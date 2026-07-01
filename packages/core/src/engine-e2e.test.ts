import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig } from "@vibe/config";
import type { UIEvent } from "@vibe/shared";
import { Engine } from "./engine.ts";

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
  // The plan was presented and persisted to .vibe/plans/<session>.md.
  expect(events.some((e) => e.type === "plan-presented")).toBe(true);
  const sessionId = engine.snapshot().sessionId;
  const planFile = await Bun.file(join(cwd, ".vibe", "plans", `${sessionId}.md`)).text();
  expect(planFile).toContain("Refactor the loader");

  // Approve: switch to execute, then run a turn — the model's prompt carries the
  // handoff directive so it doesn't read its own present_plan "stop here" as halt.
  engine.send({ type: "set-mode", mode: "execute" });
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  expect(prompts.at(-1)).toContain("approved by the user");
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
  // Switched to execute and ran the turn with the approval handoff.
  expect(events.some((e) => e.type === "mode-changed" && e.mode === "execute")).toBe(true);
  expect(prompts.at(-1)).toContain("approved by the user");
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
      { type: "tool-call", toolCallId: "p1", toolName: "present_plan", input: JSON.stringify({ plan: "1. Do the thing" }) },
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

  engine.send({ type: "submit-prompt", text: "plan a refactor" });
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
