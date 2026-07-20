import { expect, test } from "bun:test";
import type { UIEvent } from "@vibe/shared";
import {
  LoopCancelledError,
  LoopController,
  MAX_UNTIL_EVAL_FAILURES,
  parseDuration,
  parseLoopArgs,
} from "./loop.ts";

test("parseDuration handles s/m/h", () => {
  expect(parseDuration("30s")).toBe(30_000);
  expect(parseDuration("5m")).toBe(300_000);
  expect(parseDuration("2h")).toBe(7_200_000);
  expect(parseDuration("nope")).toBeNull();
});

test("parseDuration rejects a zero interval (an unpaced hot loop)", () => {
  expect(parseDuration("0s")).toBeNull();
  expect(parseDuration("0m")).toBeNull();
  expect(parseDuration("0h")).toBeNull();
});

test("parseLoopArgs rejects --max 0 instead of silently unbounding the loop", () => {
  // `max: 0` used to be discarded by a truthiness spread, turning "run at most
  // zero times" into an INFINITE loop. It must be a usage error (null).
  expect(parseLoopArgs("5m deploy --max 0")).toBeNull();
  // A positive max still parses.
  expect(parseLoopArgs("5m deploy --max 1")!.max).toBe(1);
});

test("parseLoopArgs extracts interval, prompt, --until, --max", () => {
  const p = parseLoopArgs('30s check the build --until "tests pass" --max 5');
  expect(p).not.toBeNull();
  expect(p!.intervalMs).toBe(30_000);
  expect(p!.prompt).toBe("check the build");
  expect(p!.condition).toEqual({ kind: "model", text: "tests pass" });
  expect(p!.max).toBe(5);
});

test("parseLoopArgs defaults interval, max, and allows bare prompt", () => {
  const p = parseLoopArgs("keep polling status");
  expect(p!.intervalMs).toBe(600_000);
  expect(p!.prompt).toBe("keep polling status");
  expect(p!.condition).toBeUndefined();
  expect(p!.max).toBe(12);
  expect(p!.maxDefaulted).toBe(true);
  expect(p!.unlimited).toBeUndefined();
});

test("parseLoopArgs --unlimited clears the default max cap", () => {
  const p = parseLoopArgs("5m poll forever --unlimited");
  expect(p!.max).toBeUndefined();
  expect(p!.unlimited).toBe(true);
  expect(p!.maxDefaulted).toBeUndefined();
  expect(p!.prompt).toBe("poll forever");
});

test("parseLoopArgs explicit --max wins over the default", () => {
  const p = parseLoopArgs("30s check --max 3");
  expect(p!.max).toBe(3);
  expect(p!.maxDefaulted).toBeUndefined();
});

test("parseLoopArgs returns null with no prompt", () => {
  expect(parseLoopArgs("30s")).toBeNull();
  expect(parseLoopArgs("")).toBeNull();
});

test("parseLoopArgs warns on an unknown interval unit instead of silently defaulting", () => {
  // "5x" in the interval position used to be silently swallowed into the
  // prompt — the user thinks they set a 5-something pace but got the 10m
  // default. It must warn, while still running (kept as prompt text).
  for (const token of ["5x", "30sec", "0s"]) {
    const p = parseLoopArgs(`${token} check the build`);
    expect(p).not.toBeNull();
    expect(p!.intervalMs).toBe(600_000); // default, not the mistyped value
    expect(p!.prompt).toBe(`${token} check the build`);
    expect(p!.warnings?.length).toBe(1);
    expect(p!.warnings![0]).toContain(`"${token}"`);
  }
});

test("parseLoopArgs warns when --max/--until is typed but not applied", () => {
  // `--max ten` doesn't match the numeric flag regex, so the flag used to stay
  // in the prompt with NO bound set and no hint — an unbounded loop the user
  // believes is capped. Same for a value-less trailing `--until`.
  const badMax = parseLoopArgs("5m deploy --max ten");
  expect(badMax).not.toBeNull();
  // Mistyped max is not applied; the safety default still caps the loop.
  expect(badMax!.max).toBe(12);
  expect(badMax!.maxDefaulted).toBe(true);
  expect(badMax!.warnings?.some((w) => w.includes('"--max"'))).toBe(true);

  const badUntil = parseLoopArgs("deploy --until");
  expect(badUntil).not.toBeNull();
  expect(badUntil!.condition).toBeUndefined();
  expect(badUntil!.warnings?.some((w) => w.includes('"--until"'))).toBe(true);
});

test("parseLoopArgs stays silent on legitimate prompts that merely contain -- text", () => {
  // Only the two flags the parser understands warn; arbitrary --flags in
  // prompt text (asking the model about some tool's flags) must not.
  const p = parseLoopArgs("5m run the build --watch and report failures");
  expect(p!.warnings).toBeUndefined();
  expect(p!.prompt).toBe("run the build --watch and report failures");
  // A fully well-formed invocation is warning-free too.
  const ok = parseLoopArgs('30s check ci --until "tests pass" --max 5');
  expect(ok!.warnings).toBeUndefined();
});

test("parseLoopArgs table: --until-cmd is quoted, lossless, and discriminated", () => {
  const cases = [
    {
      input: '30s check release --until-cmd "test -f READY && git diff --quiet" --max 4',
      prompt: "check release",
      command: "test -f READY && git diff --quiet",
    },
    {
      input: String.raw`--until-cmd "printf \"a\\b\" | grep ✓ && echo --max --until" 5m inspect Unicode`,
      prompt: "inspect Unicode",
      command: String.raw`printf "a\b" | grep ✓ && echo --max --until`,
    },
    {
      input: String.raw`1s poll --max 2 --until-cmd "test \"$STATE\" = done || exit 7"`,
      prompt: "poll",
      command: 'test "$STATE" = done || exit 7',
    },
    {
      input: String.raw`poll --until-cmd 'printf \'it\\works\''`,
      prompt: "poll",
      command: String.raw`printf 'it\works'`,
    },
  ];
  for (const row of cases) {
    const parsed = parseLoopArgs(row.input);
    expect(parsed).not.toBeNull();
    expect(parsed!.prompt).toBe(row.prompt);
    expect(parsed!.condition).toEqual({ kind: "command", command: row.command });
  }
});

test("parseLoopArgs rejects empty/bare/unclosed, duplicate, and mixed conditions", () => {
  for (const input of [
    "poll --until-cmd true",
    'poll --until-cmd ""',
    'poll --until-cmd "   "',
    'poll --until-cmd "test -f ready',
    'poll --until-cmd "true" --until-cmd "false"',
    'poll --until done --until-cmd "true"',
    "poll --until one --until two",
  ]) {
    expect(parseLoopArgs(input)).toBeNull();
  }
});

test("parseLoopArgs rejects duplicate unlimited and mixed valid/invalid max applications", () => {
  for (const input of [
    "poll --unlimited --unlimited",
    "poll --max 2 --max 3",
    "poll --max 2 --max nope",
    "poll --max nope --max 2",
    "poll --max 2 --max",
    "poll --max nope --max",
  ]) {
    expect(parseLoopArgs(input)).toBeNull();
  }
  // Quoted flag text remains prompt/command content, not a duplicate.
  expect(parseLoopArgs('poll "--unlimited" --unlimited')).not.toBeNull();
  expect(parseLoopArgs('poll --until-cmd "echo --max --max" --max 2')).not.toBeNull();
});

test("parseLoopArgs fuzz table: option-looking text inside quotes is never consumed", () => {
  const quotedFragments = [
    '"--max 99"',
    '"--until done"',
    '"--until-cmd \\"false\\""',
    "'--unlimited'",
    '"λ --max --until ✓"',
  ];
  for (const fragment of quotedFragments) {
    const parsed = parseLoopArgs(`10s explain ${fragment} safely --max 2`);
    expect(parsed).not.toBeNull();
    expect(parsed!.prompt).toContain(fragment);
    expect(parsed!.condition).toBeUndefined();
    expect(parsed!.max).toBe(2);
  }
  const spaced = parseLoopArgs('10s explain "✓  --max  99" exactly --max 2');
  expect(spaced!.prompt).toBe('explain "✓  --max  99" exactly');
});

test("LoopController stops after max iterations", async () => {
  const ticks: number[] = [];
  let runs = 0;
  const events: UIEvent[] = [];
  const loop = new LoopController({
    id: "L1",
    intervalMs: 1,
    prompt: "do",
    max: 3,
    run: async () => {
      runs += 1;
      return "still going";
    },
    emit: (e) => {
      events.push(e);
      if (e.type === "loop-tick") ticks.push(e.iteration);
    },
  });
  loop.start();
  await loop.whenDone();
  expect(runs).toBe(3);
  expect(ticks).toEqual([1, 2, 3]);
  const stopped = events.find((e) => e.type === "loop-stopped");
  expect(stopped && stopped.type === "loop-stopped" && stopped.reason).toContain("max");
});

test("LoopController stops when the --until condition is met", async () => {
  let runs = 0;
  const loop = new LoopController({
    id: "L2",
    intervalMs: 1,
    prompt: "build",
    condition: { kind: "model", text: "build passes" },
    run: async () => {
      runs += 1;
      return runs >= 2 ? "BUILD PASSED" : "errors";
    },
    evaluate: async (result) => ({
      done: result.includes("PASSED"),
      reason: "build is green",
    }),
    emit: () => {},
  });
  loop.start();
  await loop.whenDone();
  expect(runs).toBe(2);
});

test("LoopController treats command nonzero as not-yet and checks before max", async () => {
  let runs = 0;
  let checks = 0;
  const events: UIEvent[] = [];
  const loop = new LoopController({
    id: "L-command",
    intervalMs: 1,
    prompt: "poll",
    max: 2,
    condition: { kind: "command", command: "test -f READY" },
    run: async () => {
      runs += 1;
      return "iteration complete";
    },
    evaluate: async (_result, condition) => {
      expect(condition.kind).toBe("command");
      checks += 1;
      return { done: checks === 2, reason: "command exited 0" };
    },
    emit: (event) => events.push(event),
  });
  loop.start();
  await loop.whenDone();
  expect({ runs, checks }).toEqual({ runs: 2, checks: 2 });
  const stopped = events.find((event) => event.type === "loop-stopped");
  expect(stopped && stopped.type === "loop-stopped" && stopped.reason).toContain("condition met");
});

test("LoopController aborts an active condition evaluation on stop", async () => {
  let evaluationSignal: AbortSignal | undefined;
  const loop = new LoopController({
    id: "L-command-abort",
    intervalMs: 1,
    prompt: "poll",
    condition: { kind: "command", command: "sleep 60" },
    run: async () => "iteration complete",
    evaluate: async (_result, _condition, signal) => {
      evaluationSignal = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("aborted");
    },
    emit: () => {},
  });
  loop.start();
  for (let i = 0; i < 20 && !evaluationSignal; i++) await Bun.sleep(1);
  loop.stop("queue cleared");
  await loop.whenDone();
  expect(evaluationSignal?.aborted).toBe(true);
});

test("LoopController bounds command evaluator failures and surfaces a concise diagnostic", async () => {
  let runs = 0;
  const events: UIEvent[] = [];
  const loop = new LoopController({
    id: "L-command-failure",
    intervalMs: 1,
    prompt: "poll",
    max: 100,
    maxUntilEvalFailures: 2,
    condition: { kind: "command", command: "true" },
    run: async () => {
      runs += 1;
      return "complete";
    },
    evaluate: async () => {
      throw new Error("read-only command sandbox unavailable");
    },
    emit: (event) => events.push(event),
  });
  loop.start();
  await loop.whenDone();
  expect(runs).toBe(2);
  const stopped = events.find((event) => event.type === "loop-stopped");
  expect(stopped && stopped.type === "loop-stopped" && stopped.reason).toContain(
    "read-only command sandbox unavailable",
  );
});

test("an external stop reports 'stopped by user' and fires no iteration after the stop", async () => {
  const events: UIEvent[] = [];
  let runs = 0;
  const loop = new LoopController({
    id: "L3",
    intervalMs: 10_000,
    prompt: "x",
    run: async () => {
      runs += 1;
      return "x";
    },
    emit: (e) => events.push(e),
  });
  loop.start();
  const runsAtStop = runs; // one iteration is in-flight from the immediate first tick
  loop.stop("stopped by user");
  await loop.whenDone();
  // The stop is reported with the caller's reason, not silently swallowed.
  const stopped = events.find((e) => e.type === "loop-stopped");
  expect(stopped && stopped.type === "loop-stopped" && stopped.reason).toBe("stopped by user");
  // No iteration runs after the stop: the in-flight tick's re-schedule is
  // suppressed and the interval timer is cleared, so exactly one tick fired.
  expect(runs).toBe(runsAtStop);
  expect(events.filter((e) => e.type === "loop-tick").length).toBe(1);
});

test("a cancelled queued iteration stops the loop with a 'cancelled' reason, not a failure", async () => {
  // The engine settles a dropped-from-queue iteration by rejecting with
  // LoopCancelledError (abort / dequeue / queue clear). The loop must END —
  // previously the promise never settled and the loop hung forever while
  // still reporting active — and the reason must read as a cancellation.
  const events: UIEvent[] = [];
  const loop = new LoopController({
    id: "L4",
    intervalMs: 1,
    prompt: "x",
    run: async () => {
      throw new LoopCancelledError("queue cleared");
    },
    emit: (e) => events.push(e),
  });
  loop.start();
  await loop.whenDone();
  const stopped = events.find((e) => e.type === "loop-stopped");
  expect(stopped && stopped.type === "loop-stopped" && stopped.reason).toBe(
    "iteration cancelled (queue cleared)",
  );
});

test("a genuinely failing iteration still stops with an 'iteration failed' reason", async () => {
  const events: UIEvent[] = [];
  const loop = new LoopController({
    id: "L5",
    intervalMs: 1,
    prompt: "x",
    run: async () => {
      throw new Error("provider exploded");
    },
    emit: (e) => events.push(e),
  });
  loop.start();
  await loop.whenDone();
  const stopped = events.find((e) => e.type === "loop-stopped");
  expect(stopped && stopped.type === "loop-stopped" && stopped.reason).toBe(
    "iteration failed: provider exploded",
  );
});

test("parseLoopArgs does not steal prose --until (BUG-076)", () => {
  const p = parseLoopArgs("30s explain how --until loops work");
  expect(p).not.toBeNull();
  expect(p!.condition).toBeUndefined();
  expect(p!.prompt).toContain("--until loops work");
});

test("LoopController stops after consecutive --until eval failures", async () => {
  let runs = 0;
  const events: UIEvent[] = [];
  const loop = new LoopController({
    id: "L-evalfail",
    intervalMs: 1,
    prompt: "x",
    condition: { kind: "model", text: "done" },
    max: 100,
    run: async () => {
      runs += 1;
      return "not yet";
    },
    evaluate: async () => {
      throw new Error("model down");
    },
    emit: (e) => events.push(e),
  });
  loop.start();
  await loop.whenDone();
  expect(runs).toBe(MAX_UNTIL_EVAL_FAILURES);
  const stopped = events.find((e) => e.type === "loop-stopped");
  expect(stopped && stopped.type === "loop-stopped" && stopped.reason).toContain(
    "--until check failed",
  );
});
