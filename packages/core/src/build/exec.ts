/**
 * The one seam the build-intelligence layer hangs on: every codeintel function
 * that touches the filesystem does so through `Exec` — a single shell round-trip
 * with a cwd, timeout, and abort signal — so the pure logic stays testable with
 * a fake and the runner can later be swapped (sandbox, remote) without touching
 * recon/gitops. Mirrors agentswarm's SandboxRuntime["exec"] contract.
 */

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
export function bunExec(): Exec {
  return async (cmd, { cwd, timeoutSec, signal }) => {
    try {
      const proc = Bun.spawn(["bash", "-lc", cmd], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        ...(signal ? { signal } : {}),
      });
      const timer = timeoutSec
        ? setTimeout(() => {
            try {
              proc.kill();
            } catch {
              /* already gone */
            }
          }, timeoutSec * 1000)
        : undefined;
      try {
        const [stdout, stderr] = await Promise.all([
          readBounded(proc.stdout, MAX_PROBE_OUTPUT),
          readBounded(proc.stderr, MAX_PROBE_OUTPUT),
        ]);
        const code = await proc.exited;
        return { out: `${stdout}${stderr}`, code };
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (err) {
      return { out: (err as Error)?.message ?? String(err), code: 127 };
    }
  };
}
