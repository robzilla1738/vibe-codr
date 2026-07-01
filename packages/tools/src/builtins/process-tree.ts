/**
 * Kill a process AND its descendants. `proc.kill()` signals only the direct
 * child — a `bash -lc "npm run dev"` leaves node/vite grandchildren running
 * forever after a timeout kill or job_kill. There's no portable process-group
 * kill without setsid (absent on macOS), so walk the tree via `pgrep -P`
 * (BFS, bounded) and signal children first, root last. Best-effort by design:
 * a race with an exiting process is fine.
 */

function childrenOf(pid: number): number[] {
  try {
    const res = Bun.spawnSync(["pgrep", "-P", String(pid)]);
    if (!res.success) return [];
    return new TextDecoder()
      .decode(res.stdout)
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/** Collect pid + all descendants, children-first (leaves before parents). */
export function processTree(rootPid: number, maxProcs = 256): number[] {
  const seen = new Set<number>([rootPid]);
  const order: number[] = [];
  const queue = [rootPid];
  while (queue.length && seen.size < maxProcs) {
    const pid = queue.shift()!;
    order.push(pid);
    for (const child of childrenOf(pid)) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  // Reverse BFS order ≈ leaves first, so a parent can't respawn-supervise a
  // child we already killed.
  return order.reverse();
}

/** SIGTERM the whole tree (leaves first); escalate stragglers to SIGKILL after
 * `graceMs`. Never throws. */
export function killTree(rootPid: number, graceMs = 1_500): void {
  const pids = processTree(rootPid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone — the normal case */
      }
    }
  }, graceMs).unref();
}
