import { test, expect } from "bun:test";
import type { Session } from "../session.ts";
import { ChildRegistry } from "./child-registry.ts";

/** A stand-in for a retained Session — the registry only reads `.id` and `.cwd`. */
function fakeSession(id: string, cwd?: string): Session {
  return { id, cwd } as unknown as Session;
}

test("retain evicts in LRU order and stays bounded", () => {
  const reg = new ChildRegistry(2);
  reg.retain(fakeSession("a"));
  reg.retain(fakeSession("b"));
  reg.retain(fakeSession("c")); // evicts the oldest (a)
  expect(reg.retainedSize).toBe(2);
  expect(reg.lookup("a")).toBeUndefined();
  expect(reg.lookup("b")?.id).toBe("b");
  expect(reg.lookup("c")?.id).toBe("c");
});

test("lookup refreshes LRU position so an active child isn't evicted", () => {
  const reg = new ChildRegistry(2);
  reg.retain(fakeSession("a"));
  reg.retain(fakeSession("b"));
  expect(reg.lookup("a")?.id).toBe("a"); // bump a to most-recent
  reg.retain(fakeSession("c")); // now b (least-recent) is evicted, not a
  expect(reg.lookup("b")).toBeUndefined();
  expect(reg.lookup("a")?.id).toBe("a");
  expect(reg.lookup("c")?.id).toBe("c");
});

test("re-retaining an existing id moves it to most-recent without growing", () => {
  const reg = new ChildRegistry(2);
  const a = fakeSession("a");
  reg.retain(a);
  reg.retain(fakeSession("b"));
  reg.retain(a); // touch a again → a most-recent, size stays 2
  expect(reg.retainedSize).toBe(2);
  reg.retain(fakeSession("c")); // evicts b (least-recent), keeps a
  expect(reg.lookup("b")).toBeUndefined();
  expect(reg.lookup("a")?.id).toBe("a");
});

test("retainMax 0 disables retention (every lookup misses)", () => {
  const reg = new ChildRegistry(0);
  reg.retain(fakeSession("a"));
  expect(reg.retainedSize).toBe(0);
  expect(reg.lookup("a")).toBeUndefined();
});

test("a child whose cwd left the shared tree (worktree descendant) is NOT retained", () => {
  // Retaining a worktree-descended child would let continue_subagent resume into
  // a directory that gets deleted with the task's worktree. Only shared-tree
  // children (cwd === the root's shared cwd) are resumable.
  const reg = new ChildRegistry(4, "/repo");
  reg.retain(fakeSession("shared", "/repo")); // same as the shared tree → retained
  reg.retain(fakeSession("wt", "/repo/.worktrees/task-1")); // isolated worktree → skipped
  expect(reg.retainedSize).toBe(1);
  expect(reg.lookup("shared")?.id).toBe("shared");
  expect(reg.lookup("wt")).toBeUndefined();
});

test("evict drops a retained child by id", () => {
  const reg = new ChildRegistry(4, "/repo");
  reg.retain(fakeSession("a", "/repo"));
  expect(reg.lookup("a")?.id).toBe("a");
  reg.evict("a");
  expect(reg.lookup("a")).toBeUndefined();
  expect(reg.retainedSize).toBe(0);
});

test("detached: register, look up, count, and finish", () => {
  const reg = new ChildRegistry(4);
  const abort = new AbortController();
  const rec = {
    id: "d1",
    kind: "subagent" as const,
    status: "running" as const,
    abort,
    promise: Promise.resolve(),
    summary: "background work",
  };
  reg.registerDetached(rec);
  expect(reg.getDetached("d1")?.status).toBe("running");
  expect(reg.runningDetachedCount()).toBe(1);
  expect(reg.getDetached("missing")).toBeUndefined();

  reg.markDetachedFinished("d1", { report: "BG-RESULT", isError: false });
  expect(reg.getDetached("d1")?.status).toBe("completed");
  expect(reg.getDetached("d1")?.report).toBe("BG-RESULT");
  expect(reg.runningDetachedCount()).toBe(0);
});

test("markDetachedFinished queues a surfacing note, cleared by takePendingFinished", () => {
  const reg = new ChildRegistry(4);
  reg.registerDetached({
    id: "d1",
    kind: "subagent",
    status: "running",
    abort: new AbortController(),
    promise: Promise.resolve(),
    summary: "scout the repo",
  });
  expect(reg.takePendingFinished()).toEqual([]); // nothing yet
  reg.markDetachedFinished("d1", { report: "done", isError: false });
  const notes = reg.takePendingFinished();
  expect(notes.length).toBe(1);
  expect(notes[0]).toContain("d1");
  expect(notes[0]).toContain("completed");
  // Draining clears it — the note surfaces exactly once.
  expect(reg.takePendingFinished()).toEqual([]);
});

test("finalize shape: abortAllDetached + a bounded awaitAllDetached completes within the bound even on a wedged promise", async () => {
  // Engine.finalize() does `abortAllDetached()` then `awaitAllDetached(5_000)`.
  // Bounded finalize must terminate — a wedged detached child whose promise
  // never settles (the abort was signaled but the SDK didn't unwind) must not
  // trap graceful exit. Shadows the case `awaitAllDetached(timeoutMs)` already
  // punts; this asserts the COMBINED abort+await sequence is what finalize uses.
  const reg = new ChildRegistry(4);
  reg.registerDetached({
    id: "wedged",
    kind: "subagent",
    status: "running",
    abort: new AbortController(),
    promise: new Promise<void>(() => {}), // never resolves
    summary: "stuck",
  });
  reg.abortAllDetached();
  const start = Date.now();
  await reg.awaitAllDetached(50);
  expect(Date.now() - start).toBeLessThan(1_000);
});

test("abortAllDetached signals running children; awaitAllDetached resolves", async () => {
  const reg = new ChildRegistry(4);
  const abort = new AbortController();
  let settled = false;
  const promise = new Promise<void>((resolve) => {
    abort.signal.addEventListener("abort", () => {
      settled = true;
      resolve();
    });
  });
  reg.registerDetached({
    id: "d1",
    kind: "subagent",
    status: "running",
    abort,
    promise,
    summary: "long job",
  });
  reg.abortAllDetached();
  expect(abort.signal.aborted).toBe(true);
  await reg.awaitAllDetached(1_000);
  expect(settled).toBe(true);
});

test("awaitAllDetached is bounded — returns even if a promise never settles", async () => {
  const reg = new ChildRegistry(4);
  reg.registerDetached({
    id: "d1",
    kind: "subagent",
    status: "running",
    abort: new AbortController(),
    promise: new Promise<void>(() => {}), // never resolves
    summary: "wedged",
  });
  const start = Date.now();
  await reg.awaitAllDetached(50);
  expect(Date.now() - start).toBeLessThan(1_000); // did not hang on the wedged promise
});

test("awaitAllDetached without a timeout waits for detached work to settle", async () => {
  const reg = new ChildRegistry(4);
  let resolveDetached!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveDetached = resolve;
  });
  reg.registerDetached({
    id: "d1",
    kind: "subagent",
    status: "running",
    abort: new AbortController(),
    promise,
    summary: "slow",
  });

  let done = false;
  const wait = reg.awaitAllDetached().then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(done).toBe(false);
  resolveDetached();
  await wait;
  expect(done).toBe(true);
});
