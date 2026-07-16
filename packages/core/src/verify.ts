import { readCappedText } from "@vibe/shared";
import { killTreeAndWait, policyForChecks, type SandboxPolicy, wrapCommand } from "@vibe/tools";

export interface VerifyResult {
  ok: boolean;
  /** Combined stdout/stderr, capped for feeding back to the model. */
  output: string;
}

const MAX_OUTPUT = 8000;
/** Read each stream up to this many chars (well above the display cap) so a
 * runaway verify command can't buffer gigabytes before the cap is applied. The
 * shared reader stops + cancels at this head cap, so the writer exits on SIGPIPE. */
const MAX_STREAM = 64_000;

/**
 * Run the project's verification command (typecheck/tests/lint) in `cwd` and
 * capture the result. A non-zero exit means failure; output is capped — read
 * incrementally so a runaway command doesn't materialize its whole output in
 * memory before truncation.
 *
 * BUG-059: on abort/timeout, kill the whole process tree (not just bash -lc)
 * so grandchildren cannot hold pipes open and hang `readCappedText`.
 */
export async function runVerify(
  cwd: string,
  command: string,
  signal?: AbortSignal,
  policy?: SandboxPolicy,
): Promise<VerifyResult> {
  // Verify runs the project's own build/test commands, which write artifacts —
  // so a read-only policy is upgraded to workspace-write; an absent policy →
  // the unchanged base argv (unsandboxed).
  const argv = policy
    ? wrapCommand(policyForChecks(policy), { cwd, command })
    : ["bash", "-lc", command];
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let killed = false;
  const onAbort = () => {
    killed = true;
    void killTreeAndWait(proc.pid).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const [stdout, stderr] = await Promise.all([
      readCappedText(proc.stdout, { cap: MAX_STREAM, ...(signal ? { signal } : {}) }),
      readCappedText(proc.stderr, { cap: MAX_STREAM, ...(signal ? { signal } : {}) }),
    ]);
    const code = await proc.exited;
    const combined = `${stdout.text}${stderr.text}`.trim();
    const output =
      combined.length > MAX_OUTPUT ? `${combined.slice(0, MAX_OUTPUT)}\n…(truncated)` : combined;
    if (killed || signal?.aborted) {
      return { ok: false, output: output || "verify aborted" };
    }
    return { ok: code === 0, output };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
