export interface VerifyResult {
  ok: boolean;
  /** Combined stdout/stderr, capped for feeding back to the model. */
  output: string;
}

const MAX_OUTPUT = 8000;

/**
 * Run the project's verification command (typecheck/tests/lint) in `cwd` and
 * capture the result. A non-zero exit means failure; output is capped so it can
 * be fed back to the model without blowing up context.
 */
export async function runVerify(
  cwd: string,
  command: string,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    ...(signal ? { signal } : {}),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const combined = `${stdout}${stderr}`.trim();
  const output =
    combined.length > MAX_OUTPUT
      ? `${combined.slice(0, MAX_OUTPUT)}\n…(truncated)`
      : combined;
  return { ok: code === 0, output };
}
