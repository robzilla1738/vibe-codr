/**
 * The one seam the build-intelligence layer hangs on: every codeintel function
 * that touches the filesystem does so through `Exec` — a single shell round-trip
 * with a cwd, timeout, and abort signal — so the pure logic stays testable with
 * a fake and the runner can later be swapped (sandbox, remote) without touching
 * recon/gitops. Mirrors agentswarm's SandboxRuntime["exec"] contract.
 */

import { killTree, policyForChecks, type SandboxPolicy, wrapCommand } from "@vibe/tools";

export interface ExecResult {
  out: string;
  code: number;
}

export type Exec = (
  cmd: string,
  opts: { cwd: string; timeoutSec?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

/** Read a stream fully but bounded — recon probes are small; the cap is a
 * safety net against a pathological command, not a display concern. */
async function readBounded(stream: ReadableStream<Uint8Array>, maxChars: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.slice(0, maxChars);
}

const MAX_PROBE_OUTPUT = 400_000;

/**
 * The local Bun runner. Combined stdout+stderr (stderr matters for check
 * output), exit code, wall-clock timeout via kill. Never throws for a failing
 * command — a non-zero exit is a result, not an error; spawn failures surface
 * as `{ out: message, code: 127 }` so callers keep their "degrade, don't
 * throw" contract.
 */
export function bunExec(policy?: SandboxPolicy): Exec {
  return async (cmd, { cwd, timeoutSec, signal }) => {
    try {
      // The gate/build/verify commands MUST write artifacts, so a globally-pinned
      // read-only policy is upgraded to workspace-write for these engine-owned
      // paths. An absent policy → the unchanged base argv (unsandboxed).
      const argv = policy
        ? wrapCommand(policyForChecks(policy), { cwd, command: cmd })
        : ["bash", "-lc", cmd];
      const proc = Bun.spawn(argv, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        // Deliberately NOT forwarding `signal` to Bun.spawn: on abort Bun kills
        // only the DIRECT child (`bash -lc …`), orphaning grandchildren (test
        // workers, spawned servers) that still hold the inherited stdout/stderr
        // pipe write-ends — `readBounded` never observes EOF and `bunExec` hangs
        // forever, wedging the gate the abort was meant to stop. Instead we
        // killTree while the root is still alive (below), so `pgrep -P` can walk
        // the descendants before they reparent to PID 1.
      });
      // On timeout OR abort, kill the whole PROCESS TREE, not just the `bash -lc`
      // child — killing the tree closes the inherited pipes so the readers finish
      // and this call unwinds instead of hanging.
      const timer = timeoutSec
        ? setTimeout(() => {
            killTree(proc.pid);
          }, timeoutSec * 1000)
        : undefined;
      const onAbort = () => killTree(proc.pid);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        const [stdout, stderr] = await Promise.all([
          readBounded(proc.stdout, MAX_PROBE_OUTPUT),
          readBounded(proc.stderr, MAX_PROBE_OUTPUT),
        ]);
        const code = await proc.exited;
        return { out: `${stdout}${stderr}`, code };
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    } catch (err) {
      return { out: (err as Error)?.message ?? String(err), code: 127 };
    }
  };
}
