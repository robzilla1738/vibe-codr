export interface VerifyResult {
  ok: boolean;
  /** Combined stdout/stderr, capped for feeding back to the model. */
  output: string;
}

const MAX_OUTPUT = 8000;
/** Read each stream up to this many chars (well above the display cap) so a
 * runaway verify command can't buffer gigabytes before the cap is applied. */
const MAX_STREAM = 64_000;

/** Read a stream up to `max` chars, then cancel it (the writer exits on the pipe). */
async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

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
): Promise<VerifyResult> {
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    ...(signal ? { signal } : {}),
  });
  const [stdout, stderr] = await Promise.all([
    readCapped(proc.stdout, MAX_STREAM),
    readCapped(proc.stderr, MAX_STREAM),
  ]);
  const code = await proc.exited;
  const combined = `${stdout}${stderr}`.trim();
  const output =
    combined.length > MAX_OUTPUT
      ? `${combined.slice(0, MAX_OUTPUT)}\n…(truncated)`
      : combined;
  return { ok: code === 0, output };
}
