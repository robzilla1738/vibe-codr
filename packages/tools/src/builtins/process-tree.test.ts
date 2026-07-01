import { test, expect } from "bun:test";
import { processTree, killTree } from "./process-tree.ts";

test("processTree finds descendants, leaves-first; killTree reaps the whole tree", async () => {
  // A parent shell that spawns a grandchild sleeper — the classic orphan case:
  // killing only the shell leaves the sleep running.
  const proc = Bun.spawn(["bash", "-c", "sleep 30 & wait"], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(150); // let the grandchild spawn

  const tree = processTree(proc.pid);
  expect(tree).toContain(proc.pid);
  expect(tree.length).toBeGreaterThanOrEqual(2); // shell + sleep
  // Leaves-first: the root shell is signaled LAST.
  expect(tree[tree.length - 1]).toBe(proc.pid);

  killTree(proc.pid, 200);
  await proc.exited;
  await Bun.sleep(300);
  // Every process in the tree is gone (signal 0 probes existence).
  for (const pid of tree) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }
});
