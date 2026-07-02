import { readCappedText } from "@vibe/shared";
import { policyForChecks, type SandboxPolicy, wrapCommand } from "@vibe/tools";

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
    ...(signal ? { signal } : {}),
  });
  const [stdout, stderr] = await Promise.all([
    readCappedText(proc.stdout, { cap: MAX_STREAM }),
    readCappedText(proc.stderr, { cap: MAX_STREAM }),
  ]);
  const code = await proc.exited;
  const combined = `${stdout.text}${stderr.text}`.trim();
  const output =
    combined.length > MAX_OUTPUT
      ? `${combined.slice(0, MAX_OUTPUT)}\n…(truncated)`
      : combined;
  return { ok: code === 0, output };
}
