import { test, expect, setDefaultTimeout } from "bun:test";
// Multi-step engine+gate tests routinely take 1.5–4s each; under suite load
// they can approach or exceed the default 5s and flake. Prefer a generous
// per-file default over individual timeouts on every case.
setDefaultTimeout(20_000);
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig, type Config } from "@vibe/config";
import type { UIEvent } from "@vibe/shared";
import { readFileSync } from "node:fs";
import { Engine } from "./engine.ts";
import { CheckpointManager } from "./checkpoints.ts";
import { ledgerPath } from "./build/ledger.ts";

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({
      chunks: chunks as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}
const writeStep = (id: string, path: string, content: string) =>
  stream([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: id,
      toolName: "write",
      input: JSON.stringify({ path, content }),
    },
    { type: "finish", finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: USAGE },
  ]);
const textStep = (text: string) =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop" as const, raw: undefined }, usage: USAGE },
  ]);

function mockRegistry(model: MockLanguageModelV3): ProviderRegistry {
  return new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => model,
      listModels: async () => [],
    },
  ]);
}

/** A model that, per turn, calls `write` (a mutation) then finishes with text.
 * Even doStream calls are the write step, odd calls the finishing text — so it
 * drives an arbitrary number of mutating turns (initial + fix turns). Captures
 * every prompt it receives and every review (doGenerate) call. */
function mutatingModel(reviewVerdict: string, opts: { reviewThrows?: boolean } = {}) {
  const prompts: string[] = [];
  let stream = 0;
  let reviewCalls = 0;
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const i = stream++;
      return (
        i % 2 === 0 ? writeStep(`w${i}`, "out.txt", `generated ${i}\n`) : textStep("done")
      ) as never;
    },
    // The adversarial diff review is a single-shot generateText → doGenerate.
    doGenerate: async () => {
      reviewCalls++;
      // Simulate a hung/aborted or transient-error review provider call: the
      // review is best-effort, so a rejection must degrade (notice + proceed),
      // never kill the turn or enqueue a fix.
      if (opts.reviewThrows) throw new Error("simulated review provider failure");
      return {
        content: [{ type: "text", text: reviewVerdict }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
  });
  return { model, prompts, reviewCalls: () => reviewCalls };
}

function initGitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vibe-gate-"));
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

async function runEngine(
  dir: string,
  model: MockLanguageModelV3,
  patch: (c: Config) => void,
): Promise<UIEvent[]> {
  const config = defaultConfig();
  config.model = "mock/test";
  patch(config);
  const engine = new Engine({
    config,
    cwd: dir,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  engine.send({ type: "submit-prompt", text: "do the work" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;
  return events;
}

const notices = (events: UIEvent[]) =>
  events.filter((e): e is Extract<UIEvent, { type: "notice" }> => e.type === "notice");

test("green gate: passing checks → GREEN notice + green checkpoint + review runs", async () => {
  // scripts.test echoes a passing count; recon detects it as `bun run test`.
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { test: "echo '3 pass'" },
    }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  const { model, reviewCalls } = mutatingModel("REVIEW-CLEAN");
  const events = await runEngine(dir, model, () => {});

  // Machine-verified green, surfaced as an info notice.
  expect(notices(events).some((n) => n.level === "info" && n.message.includes("Gate: GREEN"))).toBe(
    true,
  );

  // A GREEN checkpoint was committed (fresh manager reads the persisted meta).
  const cps = await new CheckpointManager(dir).list();
  const green = cps.find((c) => c.green);
  expect(green).toBeDefined();
  expect(green!.label.startsWith("green:")).toBe(true);
  expect(green!.gate?.outcome).toBe("green");

  // The adversarial diff review ran and came back clean.
  expect(reviewCalls()).toBe(1);
  expect(notices(events).some((n) => n.message.includes("Diff review: clean"))).toBe(true);

  // Cross-run ledger writeback: the green gate persisted the confirmed commands
  // so the NEXT session's recon inherits them. (Previously appendLedger had no
  // caller, so the whole ledger feature was dead code.) BUG-049 moved the
  // store from a single in-place ledger.jsonl to per-record atomic files under
  // .vibe/ledger/ — read them, not the legacy path.
  const dir2 = join(dir, ".vibe", "ledger");
  const names = readdirSync(dir2).sort();
  expect(names.length).toBeGreaterThanOrEqual(1);
  const last = JSON.parse(readFileSync(join(dir2, names[names.length - 1]!), "utf8")) as {
    commands: Record<string, string>;
    manifestHash: string;
    commandsHash: string;
  };
  expect(last.commands.test).toBe("bun run test");
  expect(last.manifestHash).toBeTruthy();
  expect(last.commandsHash).toBeTruthy();
});

test("ledger writeback respects the build.recon.ledger kill-switch (no file when off)", async () => {
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { test: "echo '3 pass'" },
    }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  const { model } = mutatingModel("REVIEW-CLEAN");
  await runEngine(dir, model, (c) => {
    c.build.recon.ledger = false;
  });
  // Neither legacy .vibe/ledger.jsonl nor the post-BUG-049 per-record dir under
  // .vibe/ledger/ should exist once the kill-switch flips.
  const existed = existsSync(ledgerPath(dir)) || existsSync(join(dir, ".vibe", "ledger"));
  expect(existed).toBe(false);
});

test("red gate: failing checks enqueue a bounded fix turn, then stop with a warn", async () => {
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { test: "echo '2 failed'; exit 1" },
    }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  const { model, prompts, reviewCalls } = mutatingModel("REVIEW-CLEAN");
  const events = await runEngine(dir, model, (c) => {
    c.build.gate.maxRounds = 1; // one fix round, then stop
  });

  // A fix turn was enqueued carrying the structured, actionable gate failure.
  expect(prompts.some((p) => p.includes("FAIL") && p.includes("RED"))).toBe(true);
  // After the round budget it stops with a warn — never a false green.
  expect(notices(events).some((n) => n.level === "warn" && /still red/i.test(n.message))).toBe(
    true,
  );
  // Red never triggers commit-on-green or a diff review.
  expect(reviewCalls()).toBe(0);
  const cps = await new CheckpointManager(dir).list();
  expect(cps.some((c) => c.green)).toBe(false);
  // engine-idle carries the terminal RED verdict, so a headless one-shot exits
  // non-zero (CI parity) instead of reporting success on a broken build.
  const idle = events.find((e) => e.type === "engine-idle");
  expect(idle && "gate" in idle ? idle.gate : undefined).toBe("red");
});

test("unverified: no detected command → honest 'not machine-verified' notice, no checkpoint/review", async () => {
  // Non-git dir + a manifest with no test/build script → recon finds no runnable
  // check command, and a non-git dir means no checkpoints at all.
  const dir = mkdtempSync(join(tmpdir(), "vibe-gate-unverified-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }));
  const { model, reviewCalls } = mutatingModel("REVIEW-CLEAN");
  const events = await runEngine(dir, model, () => {});

  expect(notices(events).some((n) => n.message.includes("not machine-verified"))).toBe(true);
  expect(reviewCalls()).toBe(0); // no review on an unverified turn
  expect((await new CheckpointManager(dir).list()).length).toBe(0); // no checkpoint
});

test("scaffold refresh: a greenfield session that CREATES a manifest re-derives the profile and gates it", async () => {
  // The observed field bug: a session started in an EMPTY dir captures a
  // greenfield profile (no commands) ONCE; after the agent scaffolds a project
  // (create-next-app), the stale profile made the gate report UNVERIFIED
  // forever while `next build` sat there red. The gate must re-recon when a
  // mutating turn leaves it with no runnable checks.
  const dir = initGitRepo({ ".keep": "" }); // greenfield: dotfiles only
  const prompts: string[] = [];
  let i = 0;
  const failing = JSON.stringify({
    name: "fx",
    version: "1.0.0",
    scripts: { test: "echo '2 failed'; exit 1" },
  });
  const steps = [
    // Turn 1: the "scaffold" — writes a manifest whose test script FAILS.
    writeStep("w0", "package.json", failing),
    textStep("scaffolded"),
    // Gate-fix turn: pretend to fix something (keeps the red script; bounded).
    writeStep("w1", "src.ts", "export const x = 1;\n"),
    textStep("fixed?"),
  ];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return steps[i++] as never;
    },
    doGenerate: async () => ({
      content: [{ type: "text", text: "REVIEW-CLEAN" }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  });
  const events = await runEngine(dir, model, (c) => {
    c.build.gate.maxRounds = 1; // one fix round, then stop
  });

  // The refreshed profile found the new test command and the gate went RED —
  // NOT the old silent "UNVERIFIED" path.
  expect(notices(events).some((n) => n.message.includes("not machine-verified"))).toBe(false);
  expect(prompts.some((p) => p.includes("FAIL") && p.includes("RED"))).toBe(true);
  expect(notices(events).some((n) => n.level === "warn" && /still red/i.test(n.message))).toBe(
    true,
  );
});

test("dirty review: NOT REVIEW-CLEAN enqueues one fix; a 2nd review is bounded by maxRounds", async () => {
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { test: "echo '3 pass'" },
    }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  const verdict = "NOT REVIEW-CLEAN — src/x.ts:3 dead handler";
  const { model, prompts, reviewCalls } = mutatingModel(verdict);
  const events = await runEngine(dir, model, () => {}); // review.maxRounds default 1

  // Exactly one fix turn was enqueued carrying the reviewer's concrete feedback.
  expect(prompts.some((p) => p.includes("src/x.ts:3 dead handler"))).toBe(true);
  expect(notices(events).some((n) => n.message.includes("Diff review flagged issues"))).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "user-message" &&
        event.origin === "engine" &&
        event.label === "Automatic review follow-up",
    ),
  ).toBe(true);
  // The review ran ONCE — the re-gated fix turn does not review again past maxRounds.
  expect(reviewCalls()).toBe(1);
});

test("branch mode + checkpoints disabled: the review sees the turn's diff BEFORE the green commit lands", async () => {
  // Deferred sweep item: #runGate committed on green BEFORE the adversarial
  // review. With checkpoints disabled there is no checkpoint baseline, so the
  // review diff falls back to `git diff HEAD` — and branch mode's gitCommitGreen
  // had just moved HEAD over the turn's work, blanking the diff. The review then
  // silently skipped ("nothing to review") AFTER the unreviewed commit already
  // landed. The review must run against the pre-commit diff; it stays advisory
  // (the green tree is still committed once the bounded review call returns).
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { test: "echo '3 pass'" },
    }),
    "bun.lock": "",
    "out.txt": "same\n",
  });
  const reviewPrompts: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const i = call++;
      // Prompt 1: a no-op write (tree stays clean, so gitPrepare accepts the
      // work branch at the first green gate). Prompt 2: a REAL change.
      if (i === 0) return writeStep("w0", "out.txt", "same\n") as never;
      if (i === 1) return textStep("done") as never;
      if (i === 2) return writeStep("w2", "out.txt", "changed\n") as never;
      return textStep("done") as never;
    },
    doGenerate: async (options) => {
      reviewPrompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text", text: "NOT REVIEW-CLEAN — out.txt:1 suspicious change" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
  });
  const config = defaultConfig();
  config.model = "mock/test";
  config.checkpoints.enabled = false; // no checkpoint baseline → fallback diff
  config.build.commit.mode = "branch";
  // The green-ledger writeback drops .vibe/ledger.jsonl into the (untracked) work
  // tree BEFORE the first gitPrepare, whose dirty check would then refuse the
  // work branch — keep the tree clean so branch commits actually engage.
  config.build.recon.ledger = false;
  const engine = new Engine({
    config,
    cwd: dir,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  engine.send({ type: "submit-prompt", text: "no-op turn" });
  await engine.whenIdle();
  // The work branch was prepared on the first (clean-tree) green gate.
  expect(notices(events).some((n) => n.message.includes("on work branch"))).toBe(true);
  engine.send({ type: "submit-prompt", text: "real change" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // The review actually ran against the REAL diff (it was blank — and silently
  // skipped — when the commit came first).
  expect(reviewPrompts.some((p) => p.includes("changed"))).toBe(true);
  const ns = notices(events);
  const flaggedIdx = ns.findIndex((n) => n.message.includes("Diff review flagged issues"));
  const commitIdx = ns.findIndex((n) => n.message.includes("Committed green checkpoint"));
  expect(flaggedIdx).toBeGreaterThanOrEqual(0);
  // Advisory, not blocking: the flagged green tree is still committed…
  expect(commitIdx).toBeGreaterThanOrEqual(0);
  // …but the review verdict landed BEFORE the commit (it saw the pre-commit diff).
  expect(flaggedIdx).toBeLessThan(commitIdx);
});

test("aborted gate: an Esc mid-gate is a terminal non-verdict — no fix, no green checkpoint, quiet notice", async () => {
  // The test command signals it has started (a marker file) then blocks until the
  // test releases it, so we can deterministically Esc while the gate is mid-check.
  // Releasing lets the (now-aborted) check exit cleanly so the reader never wedges.
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: {
        test: "echo started > gate-started; until [ -f release ]; do sleep 0.05; done; echo '3 pass'",
      },
    }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  const { model, prompts, reviewCalls } = mutatingModel("REVIEW-CLEAN");
  const config = defaultConfig();
  config.model = "mock/test";
  const engine = new Engine({
    config,
    cwd: dir,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  engine.send({ type: "submit-prompt", text: "do the work" });
  // Wait until the gate's check subprocess has actually started, then Esc + let
  // the aborted check exit cleanly.
  const marker = join(dir, "gate-started");
  const deadline = Date.now() + 15_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  engine.send({ type: "abort" });
  writeFileSync(join(dir, "release"), "");
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;

  // ABORTED is a non-verdict: an honest info notice, and NONE of the green path.
  expect(
    notices(events).some((n) => n.level === "info" && n.message.includes("Gate: ABORTED")),
  ).toBe(true);
  // No gate-fix turn enqueued (no RED fix prompt) and no adversarial review ran.
  expect(prompts.some((p) => p.includes("RED (fix round"))).toBe(false);
  expect(reviewCalls()).toBe(0);
  // No commit-on-green — an interrupt must never persist a green checkpoint.
  expect((await new CheckpointManager(dir).list()).some((c) => c.green)).toBe(false);
});

test("review failure: a rejected diff-review call degrades — turn completes, no review-fix, notice", async () => {
  // Green gate → the adversarial review runs, but the provider call rejects
  // (simulating a hung/aborted or transient failure). It must skip with a calm
  // notice and let the turn finish, never wedge `vibe -p` or enqueue a fix.
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { test: "echo '3 pass'" },
    }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  const { model, prompts, reviewCalls } = mutatingModel("REVIEW-CLEAN", { reviewThrows: true });
  const events = await runEngine(dir, model, () => {});

  // The review was attempted once, then failed.
  expect(reviewCalls()).toBe(1);
  // It degraded to a calm notice instead of killing the turn or enqueuing a fix.
  expect(notices(events).some((n) => n.message.includes("Diff review skipped"))).toBe(true);
  // No review-fix turn: the whole run is just the initial turn's two doStream
  // calls (write + finishing text); a fix turn would add two more.
  expect(prompts.length).toBe(2);
  // The green checkpoint was still committed — the review is downstream of it.
  expect((await new CheckpointManager(dir).list()).some((c) => c.green)).toBe(true);
});

// Drive a full plan→execute chain over a GREEN repo. `handoffSteps` is the
// sequence the model streams AFTER the plan is accepted (the handoff turn, then
// any continuation turns). Returns collected events + captured prompts.
async function runPlanChain(
  dir: string,
  planChecklist: string,
  handoffSteps: unknown[],
): Promise<{ events: UIEvent[]; prompts: string[] }> {
  const prompts: string[] = [];
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "p1",
        toolName: "present_plan",
        input: JSON.stringify({ plan: planChecklist }),
      },
      { type: "finish", finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: USAGE },
    ]),
    textStep("Plan presented."),
    ...handoffSteps,
  ];
  let call = 0;
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return (steps[call++] ?? textStep("idle")) as never;
    },
  });
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", mode: "plan" },
    cwd: dir,
    registry: mockRegistry(model),
    interactive: false,
  });
  await engine.bootstrap();
  const events: UIEvent[] = [];
  const collector = (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  engine.send({ type: "submit-prompt", text: "plan the work" });
  await engine.whenIdle();
  engine.send({ type: "resolve-plan", decision: "accept" });
  await engine.whenIdle();
  engine.send({ type: "shutdown" });
  await collector;
  return { events, prompts };
}

const updateTasksStep = (id: string, updates: { id: string; status: string }[]) =>
  stream([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: id,
      toolName: "update_tasks",
      input: JSON.stringify({ updates }),
    },
    { type: "finish", finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: USAGE },
  ]);

test("plan chain: a GREEN gate does NOT auto-complete an in-progress task the model never finished", async () => {
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { test: "echo '3 pass'" },
    }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  // Handoff turn: mutate + mark ONLY t1 completed (t2 left in_progress), then
  // finish. The gate is green — but greenness is orthogonal to whether t2's own
  // work was done, so t2 must NOT be auto-completed. A continuation is enqueued;
  // on it the model finishes t2 so the chain converges.
  const handoff = [
    writeStep("w1", "out.txt", "did t1\n"),
    updateTasksStep("u1", [{ id: "t1", status: "completed" }]),
    textStep("t1 done."),
    // continuation turn:
    updateTasksStep("u2", [{ id: "t2", status: "completed" }]),
    textStep("t2 done."),
  ];
  const { events, prompts } = await runPlanChain(
    dir,
    "## Steps\n- [ ] Do t1\n- [ ] Do t2",
    handoff,
  );

  // The old false-complete notice must NOT appear.
  expect(notices(events).some((n) => /marked .*in-progress task/i.test(n.message))).toBe(false);
  // Instead a bounded continuation was enqueued naming the unfinished task.
  expect(prompts.some((p) => p.includes("The approved plan is not finished"))).toBe(true);
});

test("plan chain: a non-mutating handoff turn still nudges unfinished tasks (no silent stall)", async () => {
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { test: "echo '3 pass'" },
    }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  // Handoff turn does NOT mutate — just narrates. The chain must not die silently
  // with tasks pending; a continuation is enqueued. On it the model finishes.
  const handoff = [
    textStep("Thinking about how to start…"), // non-mutating → non-gateable
    writeStep("w1", "out.txt", "did it\n"),
    updateTasksStep("u1", [{ id: "t1", status: "completed" }]),
    textStep("t1 done."),
  ];
  const { prompts } = await runPlanChain(dir, "## Steps\n- [ ] Do t1", handoff);
  expect(prompts.some((p) => p.includes("The approved plan is not finished"))).toBe(true);
});

test("legacy fallback: build.enabled=false runs the old verify.auto loop (no gate)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-gate-legacy-"));
  const { model, reviewCalls } = mutatingModel("REVIEW-CLEAN");
  const events = await runEngine(dir, model, (c) => {
    c.build.enabled = false; // build intelligence off → legacy path
    c.verify = { command: "exit 1", auto: true, maxRetries: 1 };
  });

  // The legacy verify command ran (initial turn + one retry), then stopped.
  expect(events.filter((e) => e.type === "verify-started").length).toBe(2);
  expect(notices(events).some((n) => n.message.includes("stopping auto-fix"))).toBe(true);
  // No gate / review machinery engaged on the legacy path.
  expect(notices(events).some((n) => n.message.startsWith("Gate:"))).toBe(false);
  expect(reviewCalls()).toBe(0);
});

test("manifestSignature: stable when unchanged, flips when a build manifest appears", async () => {
  const { manifestSignature } = await import("./engine.ts");
  const dir = mkdtempSync(join(tmpdir(), "vibe-sig-"));
  const empty = manifestSignature(dir);
  // A check-less repo (no manifests) → stable signature across turns → the gate
  // refresh skips the repeat recon instead of thrashing.
  expect(manifestSignature(dir)).toBe(empty);
  // A scaffolder writing package.json flips the signature → refresh re-scans.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { build: "tsc" } }),
  );
  const scaffolded = manifestSignature(dir);
  expect(scaffolded).not.toBe(empty);
  expect(scaffolded).toBe(manifestSignature(dir)); // stable again until it changes
});

test("engine-idle reports GREEN when a RED gate is fixed to green (guard doesn't pin red)", async () => {
  // The gate passes only once `pass.txt` exists. Turn 1 (writes out.txt) → RED →
  // fix turn writes pass.txt → GREEN. engine-idle must report the FIXED green
  // outcome, not stay pinned red — a genuine red→green fix DOES overwrite.
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { test: "test -f pass.txt" },
    }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  let call = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const i = call++;
      // Turn 1: write out.txt (no pass.txt → red). Fix turn: write pass.txt (→ green).
      if (i === 0) return writeStep("w0", "out.txt", "x\n") as never;
      if (i === 1) return textStep("done") as never;
      if (i === 2) return writeStep("w2", "pass.txt", "ok\n") as never;
      return textStep("fixed") as never;
    },
  });
  const events = await runEngine(dir, model, (c) => {
    c.build.gate.maxRounds = 2;
  });
  const idle = events.find((e) => e.type === "engine-idle");
  expect(idle && "gate" in idle ? idle.gate : undefined).toBe("green");
});

test("manifestSignature: flips when checks arrive via a NON-manifest file (a test file)", async () => {
  const { manifestSignature } = await import("./engine.ts");
  const dir = mkdtempSync(join(tmpdir(), "vibe-sig-nm-"));
  // A repo whose only manifest has no scripts — the sig must still change when a
  // test file appears, so the gate re-recons instead of staying UNVERIFIED.
  writeFileSync(join(dir, "pyproject.toml"), "[project]\nname='x'\n");
  const before = manifestSignature(dir);
  writeFileSync(join(dir, "test_app.py"), "def test_ok():\n    assert True\n");
  expect(manifestSignature(dir)).not.toBe(before); // top-level entry set changed
});

test("manifestSignature ignores incidental files (a scratch log doesn't thrash recon)", async () => {
  const { manifestSignature } = await import("./engine.ts");
  const dir = mkdtempSync(join(tmpdir(), "vibe-sig-inc-"));
  writeFileSync(join(dir, "pyproject.toml"), "[project]\nname='x'\n");
  const before = manifestSignature(dir);
  // Incidental churn on a check-less repo must NOT flip the sig (would re-recon
  // every turn — the V2-18 thrash the entry-set could otherwise re-introduce).
  writeFileSync(join(dir, "scratch.log"), "noise\n");
  writeFileSync(join(dir, "notes.md"), "notes\n");
  writeFileSync(join(dir, ".DS_Store"), "cruft\n");
  expect(manifestSignature(dir)).toBe(before);
  // But a real source/test file still flips it.
  writeFileSync(join(dir, "test_app.py"), "def test_ok(): assert True\n");
  expect(manifestSignature(dir)).not.toBe(before);
});
