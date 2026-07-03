import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig, type Config } from "@vibe/config";
import type { UIEvent } from "@vibe/shared";
import { readFileSync } from "node:fs";
import { Engine } from "./engine.ts";
import { CheckpointManager } from "./checkpoints.ts";
import { ledgerPath } from "./build/ledger.ts";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function stream(chunks: unknown[]) {
  return { stream: simulateReadableStream({ chunks: chunks as never[], initialDelayInMs: 0, chunkDelayInMs: 0 }) };
}
const writeStep = (id: string, path: string, content: string) =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName: "write", input: JSON.stringify({ path, content }) },
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

function mockRegistry(model: MockLanguageModelV2): ProviderRegistry {
  return new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
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
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const i = stream++;
      return (i % 2 === 0 ? writeStep(`w${i}`, "out.txt", `generated ${i}\n`) : textStep("done")) as never;
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
        finishReason: "stop" as const,
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
  const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.dev"]);
  g(["config", "user.name", "t"]);
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
  return dir;
}

async function runEngine(
  dir: string,
  model: MockLanguageModelV2,
  patch: (c: Config) => void,
): Promise<UIEvent[]> {
  const config = defaultConfig();
  config.model = "mock/test";
  patch(config);
  const engine = new Engine({ config, cwd: dir, registry: mockRegistry(model), interactive: false });
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
    "package.json": JSON.stringify({ name: "fx", version: "1.0.0", scripts: { test: "echo '3 pass'" } }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  const { model, reviewCalls } = mutatingModel("REVIEW-CLEAN");
  const events = await runEngine(dir, model, () => {});

  // Machine-verified green, surfaced as an info notice.
  expect(notices(events).some((n) => n.level === "info" && n.message.includes("Gate: GREEN"))).toBe(true);

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
  // to .vibe/ledger.jsonl so the NEXT session's recon inherits them. (Previously
  // appendLedger had no caller, so the whole ledger feature was dead code.)
  const ledger = readFileSync(ledgerPath(dir), "utf8").trim().split("\n").filter(Boolean);
  expect(ledger.length).toBeGreaterThanOrEqual(1);
  const rec = JSON.parse(ledger[ledger.length - 1]!) as {
    commands: Record<string, string>;
    manifestHash: string;
    commandsHash: string;
  };
  expect(rec.commands.test).toBe("bun run test");
  expect(rec.manifestHash).toBeTruthy();
  expect(rec.commandsHash).toBeTruthy();
});

test("ledger writeback respects the build.recon.ledger kill-switch (no file when off)", async () => {
  const dir = initGitRepo({
    "package.json": JSON.stringify({ name: "fx", version: "1.0.0", scripts: { test: "echo '3 pass'" } }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  const { model } = mutatingModel("REVIEW-CLEAN");
  await runEngine(dir, model, (c) => {
    c.build.recon.ledger = false;
  });
  let existed = true;
  try {
    readFileSync(ledgerPath(dir), "utf8");
  } catch {
    existed = false;
  }
  expect(existed).toBe(false);
});

test("red gate: failing checks enqueue a bounded fix turn, then stop with a warn", async () => {
  const dir = initGitRepo({
    "package.json": JSON.stringify({ name: "fx", version: "1.0.0", scripts: { test: "echo '2 failed'; exit 1" } }),
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
  expect(notices(events).some((n) => n.level === "warn" && /still red/i.test(n.message))).toBe(true);
  // Red never triggers commit-on-green or a diff review.
  expect(reviewCalls()).toBe(0);
  const cps = await new CheckpointManager(dir).list();
  expect(cps.some((c) => c.green)).toBe(false);
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
  const failing = JSON.stringify({ name: "fx", version: "1.0.0", scripts: { test: "echo '2 failed'; exit 1" } });
  const steps = [
    // Turn 1: the "scaffold" — writes a manifest whose test script FAILS.
    writeStep("w0", "package.json", failing),
    textStep("scaffolded"),
    // Gate-fix turn: pretend to fix something (keeps the red script; bounded).
    writeStep("w1", "src.ts", "export const x = 1;\n"),
    textStep("fixed?"),
  ];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return steps[i++] as never;
    },
    doGenerate: async () => ({
      content: [{ type: "text", text: "REVIEW-CLEAN" }],
      finishReason: "stop" as const,
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
  expect(notices(events).some((n) => n.level === "warn" && /still red/i.test(n.message))).toBe(true);
});

test("dirty review: NOT REVIEW-CLEAN enqueues one fix; a 2nd review is bounded by maxRounds", async () => {
  const dir = initGitRepo({
    "package.json": JSON.stringify({ name: "fx", version: "1.0.0", scripts: { test: "echo '3 pass'" } }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  const verdict = "NOT REVIEW-CLEAN — src/x.ts:3 dead handler";
  const { model, prompts, reviewCalls } = mutatingModel(verdict);
  const events = await runEngine(dir, model, () => {}); // review.maxRounds default 1

  // Exactly one fix turn was enqueued carrying the reviewer's concrete feedback.
  expect(prompts.some((p) => p.includes("src/x.ts:3 dead handler"))).toBe(true);
  expect(notices(events).some((n) => n.message.includes("Diff review flagged issues"))).toBe(true);
  // The review ran ONCE — the re-gated fix turn does not review again past maxRounds.
  expect(reviewCalls()).toBe(1);
});

test("aborted gate: an Esc mid-gate is a terminal non-verdict — no fix, no green checkpoint, quiet notice", async () => {
  // The test command signals it has started (a marker file) then blocks until the
  // test releases it, so we can deterministically Esc while the gate is mid-check.
  // Releasing lets the (now-aborted) check exit cleanly so the reader never wedges.
  const dir = initGitRepo({
    "package.json": JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { test: "echo started > gate-started; until [ -f release ]; do sleep 0.05; done; echo '3 pass'" },
    }),
    "bun.lock": "",
    "src.ts": "export const x = 1;\n",
  });
  const { model, prompts, reviewCalls } = mutatingModel("REVIEW-CLEAN");
  const config = defaultConfig();
  config.model = "mock/test";
  const engine = new Engine({ config, cwd: dir, registry: mockRegistry(model), interactive: false });
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
  expect(notices(events).some((n) => n.level === "info" && n.message.includes("Gate: ABORTED"))).toBe(true);
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
    "package.json": JSON.stringify({ name: "fx", version: "1.0.0", scripts: { test: "echo '3 pass'" } }),
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
