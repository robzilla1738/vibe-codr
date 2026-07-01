import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";
import type { BackgroundJobs } from "./jobs.ts";

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
/** Head cap on the model-facing captured output (bounds memory during streaming). */
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

      const proc = Bun.spawn(["bash", "-lc", command], {
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
        signal: ctx.abortSignal,
      });

      const limit = timeoutMs ?? DEFAULT_TIMEOUT;
      // Record that WE killed the process for exceeding the timeout, so the
      // model isn't handed a bare SIGTERM exit code (143) it would read as a
      // genuine command failure — without this it can't tell a hang apart from
      // an error, so it can't decide to raise the timeout or use background.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, limit);

      let out = "";
      // Bound the retained buffer to the head cap DURING streaming, not after: a
      // high-volume command (`yes`, a chatty build) is drained as fast as it's
      // produced, so an unbounded `out` grows to gigabytes before the process
      // exits and OOM-crashes the turn. We still forward every chunk to the UI
      // (progress is transient); only the model-facing capture is capped.
      let capped = false;
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        // One decoder per stream with streaming mode so a multibyte UTF-8
        // character split across chunk boundaries isn't corrupted into `�`.
        const decoder = new TextDecoder();
        const emit = (text: string) => {
          if (!text) return;
          ctx.emit({
            type: "tool-call-progress",
            sessionId: ctx.sessionId,
            toolCallId: ctx.toolCallId,
            chunk: text,
          });
          if (out.length >= OUTPUT_CAP) {
            capped = true;
            return;
          }
          out += text;
          if (out.length > OUTPUT_CAP) {
            out = out.slice(0, OUTPUT_CAP);
            capped = true;
          }
        };
        for await (const chunk of stream) emit(decoder.decode(chunk, { stream: true }));
        emit(decoder.decode()); // flush any buffered trailing bytes
      };

      await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
      const code = await proc.exited;
      clearTimeout(timer);

      const trimmed = capped ? `${out}\n…(truncated)` : out;
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
