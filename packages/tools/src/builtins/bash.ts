import { z } from "zod";
import { CappedText, drainTextStream, omittedMarker, type ToolDefinition } from "@vibe/shared";
import type { BackgroundJobs } from "./jobs.ts";
import { killTreeAndWait } from "./process-tree.ts";

const Input = z.object({
  command: z.string().describe("Shell command to execute."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Timeout in ms (default 120000)."),
  background: z
    .boolean()
    .optional()
    .describe("Run detached and return a job id immediately; poll with job_status."),
});

const DEFAULT_TIMEOUT = 120_000;
/** Cap on the model-facing captured output (bounds memory during streaming). Kept
 * as head+tail rather than head-only: a failing build prints its error LAST, so
 * dropping the tail would hide exactly the line the model needs to see. */
const OUTPUT_CAP = 30_000;

/** Build the bash tool. A shared job registry enables `background: true`. */
export function bashTool(jobs?: BackgroundJobs): ToolDefinition<z.infer<typeof Input>> {
  return {
    name: "bash",
    description:
      "Execute a shell command in the session working directory. Streams output and returns combined stdout/stderr and the exit code. Use background:true for long-running commands (build/watch/server) and poll with job_status.",
    inputSchema: Input,
    readOnly: false,
    concurrencySafe: false,
    async execute({ command, timeoutMs, background }, ctx) {
      if (background) {
        if (!jobs) {
          return { output: "Background execution is unavailable here.", isError: true };
        }
        const job = jobs.start(command, ctx.cwd);
        return {
          output: `Started ${job.id} in the background. Poll with job_status({id:"${job.id}"}).`,
        };
      }

      // NOTE: we do NOT hand Bun the abort signal. Bun's `signal` SIGTERMs only
      // the direct `bash` child; its grandchildren (node/vite under `npm run
      // dev`) then reparent to PID 1 and leak, holding their port. We kill the
      // whole tree ourselves — while bash is still alive to be its children's
      // parent, so `pgrep -P` can still find them (a deferred kill after bash
      // exits would find nothing).
      const proc = Bun.spawn(["bash", "-lc", command], {
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const limit = timeoutMs ?? DEFAULT_TIMEOUT;
      // Record that WE killed the process for exceeding the timeout, so the
      // model isn't handed a bare SIGTERM exit code (143) it would read as a
      // genuine command failure — without this it can't tell a hang apart from
      // an error, so it can't decide to raise the timeout or use background.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void killTreeAndWait(proc.pid).catch(() => {});
      }, limit);
      // Esc/steer aborts the turn: reap the tree the same way (a foreground
      // `npm run dev` must not outlive the aborted turn as an orphan).
      const onAbort = () => void killTreeAndWait(proc.pid).catch(() => {});
      ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
      if (ctx.abortSignal.aborted) onAbort();

      // Bound the retained buffer to the cap DURING streaming, not after: a
      // high-volume command (`yes`, a chatty build) is drained as fast as it's
      // produced, so an unbounded buffer grows to gigabytes before the process
      // exits and OOM-crashes the turn. We still forward every chunk to the UI
      // (progress is transient); only the model-facing capture is capped. Both
      // streams share one buffer so their interleaving is preserved.
      const out = new CappedText({ cap: OUTPUT_CAP, keep: "head+tail", marker: omittedMarker });
      const pump = (stream: ReadableStream<Uint8Array>) =>
        drainTextStream(stream, (chunk) => {
          ctx.emit({
            type: "tool-call-progress",
            sessionId: ctx.sessionId,
            toolCallId: ctx.toolCallId,
            chunk,
          });
          out.push(chunk);
        });

      let code: number;
      try {
        await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
        code = await proc.exited;
      } finally {
        clearTimeout(timer);
        ctx.abortSignal.removeEventListener("abort", onAbort);
      }

      const trimmed = out.toString();
      const status = timedOut
        ? `timed out after ${limit}ms (process killed; rerun with a larger timeoutMs or background:true)`
        : `exit ${code}`;
      return {
        output: `${status}\n${trimmed || "(no output)"}`,
        isError: timedOut || code !== 0,
      };
    },
  };
}
