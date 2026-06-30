import { test, expect } from "bun:test";
import { validateDag, runDag, type TaskSpec, type TaskResult } from "./orchestrator.ts";

const spec = (id: string, deps: string[] = []): TaskSpec => ({ id, objective: `do ${id}`, deps });
const completed = (id: string): TaskResult => ({
  id,
  objective: `do ${id}`,
  outcome: "completed",
  output: `${id} done`,
  attempts: 1,
});
const tick = () => new Promise((r) => setTimeout(r, 1));

test("validateDag catches empty / duplicate / unknown-dep / self-dep / cycle", () => {
  expect(validateDag([])).toMatch(/no tasks/);
  expect(validateDag([spec("a"), spec("a")])).toMatch(/duplicate/);
  expect(validateDag([spec("a", ["x"])])).toMatch(/unknown/);
  expect(validateDag([spec("a", ["a"])])).toMatch(/itself/);
  expect(validateDag([spec("a", ["b"]), spec("b", ["a"])])).toMatch(/cycle/);
  expect(validateDag([spec("a"), spec("b", ["a"]), spec("c", ["b"])])).toBeNull();
});

test("runs a dependent only after its dependency completes", async () => {
  const order: string[] = [];
  const runTask = async (s: TaskSpec) => {
    order.push(`start:${s.id}`);
    await tick();
    order.push(`end:${s.id}`);
    return completed(s.id);
  };
  const results = await runDag([spec("a"), spec("b", ["a"])], runTask);
  expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  expect(results.map((r) => r.id)).toEqual(["a", "b"]); // original order preserved
  expect(results.every((r) => r.outcome === "completed")).toBe(true);
});

test("runs independent tasks in parallel", async () => {
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const runTask = async (s: TaskSpec) => {
    active++;
    peak = Math.max(peak, active);
    await barrier;
    active--;
    return completed(s.id);
  };
  const p = runDag([spec("a"), spec("b"), spec("c")], runTask);
  await tick();
  expect(peak).toBe(3); // all three dispatched at once (no deps)
  release();
  await p;
});

test("skips a task whose dependency failed, without running it", async () => {
  const ran: string[] = [];
  const runTask = async (s: TaskSpec): Promise<TaskResult> => {
    ran.push(s.id);
    if (s.id === "a") {
      return { id: "a", objective: "do a", outcome: "failed", output: "boom", attempts: 1 };
    }
    return completed(s.id);
  };
  const results = await runDag([spec("a"), spec("b", ["a"]), spec("c", ["b"])], runTask);
  expect(ran).toEqual(["a"]); // b and c never ran
  expect(results.find((r) => r.id === "b")!.outcome).toBe("skipped");
  expect(results.find((r) => r.id === "c")!.outcome).toBe("skipped"); // transitively
});

test("threads dependency results into the dependent's runTask", async () => {
  let seen: TaskResult[] = [];
  const runTask = async (s: TaskSpec, deps: TaskResult[]) => {
    if (s.id === "b") seen = deps;
    return completed(s.id);
  };
  await runDag([spec("a"), spec("b", ["a"])], runTask);
  expect(seen.map((r) => r.id)).toEqual(["a"]);
  expect(seen[0]!.output).toBe("a done");
});

test("a runTask that throws becomes a failed result, not an unhandled rejection", async () => {
  const runTask = async (s: TaskSpec): Promise<TaskResult> => {
    if (s.id === "a") throw new Error("kaboom");
    return completed(s.id);
  };
  const results = await runDag([spec("a"), spec("b")], runTask);
  expect(results.find((r) => r.id === "a")!.outcome).toBe("failed");
  expect(results.find((r) => r.id === "a")!.output).toMatch(/kaboom/);
  expect(results.find((r) => r.id === "b")!.outcome).toBe("completed");
});

test("emits running + terminal status for each task", async () => {
  const statuses: string[] = [];
  await runDag([spec("a"), spec("b", ["a"])], async (s) => completed(s.id), {
    onStatus: (s, status) => statuses.push(`${s.id}:${status}`),
  });
  expect(statuses).toContain("a:running");
  expect(statuses).toContain("a:completed");
  expect(statuses).toContain("b:running");
  expect(statuses).toContain("b:completed");
});
