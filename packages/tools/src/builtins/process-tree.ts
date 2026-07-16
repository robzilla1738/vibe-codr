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

/** SIGTERM the whole tree (leaves first). Never throws. Returns the tree it
 * signaled so an awaiting caller can escalate the same set. */
function sigtermTree(rootPid: number): number[] {
  const pids = processTree(rootPid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  return pids;
}

/** Fire-and-forget: SIGTERM the whole tree (leaves first); escalate stragglers
 * to SIGKILL after `graceMs`. Never throws. The escalation timer is UNREF'd so
 * it can't hold a shutting-down process open — which means it only fires while
 * something else keeps the loop alive (the pump/read awaits in `bash`/`bunExec`
 * during a kill do). A caller that must GUARANTEE escalation on a path with no
 * other pending work (engine shutdown, `jobs.killAll`) should await
 * `killTreeAndWait` instead. */
export function killTree(rootPid: number, graceMs = 1_500): void {
  const pids = sigtermTree(rootPid);
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

/** Awaited variant: SIGTERM the tree, wait out `graceMs` on a REF'd timer (so
 * the escalation is guaranteed to run even when nothing else keeps the event
 * loop alive), then SIGKILL any survivor. A SIGTERM-ignoring descendant
 * (`trap '' TERM`, a hung server) is therefore always reaped rather than left as
 * an orphan when the caller exits within the grace window. Never throws. */
export async function killTreeAndWait(rootPid: number, graceMs = 1_500): Promise<void> {
  const pids = sigtermTree(rootPid);
  await Bun.sleep(graceMs);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone — the normal case */
    }
  }
}
