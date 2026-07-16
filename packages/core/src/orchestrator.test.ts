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

test("a seed for an unchanged objective is honored (task not re-run)", async () => {
  const ran: string[] = [];
  const results = await runDag(
    [spec("impl")], // objective "do impl"
    async (s) => {
      ran.push(s.id);
      return completed(s.id);
    },
    { seed: [completed("impl")] }, // seeded objective "do impl" — matches
  );
  expect(ran).toEqual([]); // seeded, never re-run
  expect(results.find((r) => r.id === "impl")?.outcome).toBe("completed");
});

test("a seed for a REUSED id whose objective changed is ignored (task re-runs)", async () => {
  // Plan drift: the journal has `impl` = "add login" but this plan's `impl` is
  // "add logout" — a different task. It must re-run, not return the stale result.
  const ran: string[] = [];
  const staleSeed: TaskResult = {
    id: "impl",
    objective: "add login",
    outcome: "completed",
    output: "login done",
    attempts: 1,
  };
  const results = await runDag(
    [{ id: "impl", objective: "add logout", deps: [] }],
    async (s) => {
      ran.push(s.id);
      return {
        id: s.id,
        objective: s.objective,
        outcome: "completed",
        output: "logout done",
        attempts: 1,
      };
    },
    { seed: [staleSeed] },
  );
  expect(ran).toEqual(["impl"]); // re-ran, not seeded
  expect(results.find((r) => r.id === "impl")?.output).toBe("logout done");
});

test("a re-run task (objective drift) also re-runs its already-seeded dependents", async () => {
  // Prior run seeded A(obj X) and B(deps [A]). Resume with A's objective changed:
  // A re-runs — and B MUST re-run too, else B's stale result is retained against a
  // freshly-recomputed A.
  const ran: string[] = [];
  const runTask = async (s: TaskSpec): Promise<TaskResult> => {
    ran.push(s.id);
    return {
      id: s.id,
      objective: s.objective,
      outcome: "completed",
      output: `${s.id} fresh`,
      attempts: 1,
    };
  };
  const seed: TaskResult[] = [
    { id: "a", objective: "old A", outcome: "completed", output: "a stale", attempts: 1 },
    { id: "b", objective: "do b", outcome: "completed", output: "b stale", attempts: 1 },
  ];
  const results = await runDag(
    [
      { id: "a", objective: "new A", deps: [] },
      { id: "b", objective: "do b", deps: ["a"] },
    ],
    runTask,
    { seed },
  );
  // Both re-ran (A drifted; B depends on the re-run A) — neither seeded.
  expect(ran.sort()).toEqual(["a", "b"]);
  expect(results.find((r) => r.id === "b")?.output).toBe("b fresh");
});

test("a seeded task whose deps are ALL unchanged is not re-run (normal resume)", async () => {
  const ran: string[] = [];
  const results = await runDag(
    [spec("a"), spec("b", ["a"])],
    async (s) => {
      ran.push(s.id);
      return completed(s.id);
    },
    { seed: [completed("a"), completed("b")] },
  );
  expect(ran).toEqual([]); // fully seeded, nothing re-ran
  expect(results).toHaveLength(2);
});
