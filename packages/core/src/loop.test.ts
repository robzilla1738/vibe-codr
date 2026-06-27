import { test, expect } from "bun:test";
import type { UIEvent } from "@vibe/shared";
import { LoopController, parseLoopArgs, parseDuration } from "./loop.ts";

test("parseDuration handles s/m/h", () => {
  expect(parseDuration("30s")).toBe(30_000);
  expect(parseDuration("5m")).toBe(300_000);
  expect(parseDuration("2h")).toBe(7_200_000);
  expect(parseDuration("nope")).toBeNull();
});

test("parseLoopArgs extracts interval, prompt, --until, --max", () => {
  const p = parseLoopArgs('30s check the build --until "tests pass" --max 5');
  expect(p).not.toBeNull();
  expect(p!.intervalMs).toBe(30_000);
  expect(p!.prompt).toBe("check the build");
  expect(p!.until).toBe("tests pass");
  expect(p!.max).toBe(5);
});

test("parseLoopArgs defaults interval and allows bare prompt", () => {
  const p = parseLoopArgs("keep polling status");
  expect(p!.intervalMs).toBe(600_000);
  expect(p!.prompt).toBe("keep polling status");
  expect(p!.until).toBeUndefined();
});

test("parseLoopArgs returns null with no prompt", () => {
  expect(parseLoopArgs("30s")).toBeNull();
  expect(parseLoopArgs("")).toBeNull();
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
    until: "build passes",
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

test("LoopController can be stopped externally", async () => {
  const loop = new LoopController({
    id: "L3",
    intervalMs: 10_000,
    prompt: "x",
    run: async () => "x",
    emit: () => {},
  });
  loop.start();
  loop.stop("stopped by user");
  await loop.whenDone();
  expect(true).toBe(true);
});
