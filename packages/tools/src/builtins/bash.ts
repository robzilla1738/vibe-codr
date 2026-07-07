import { z } from "zod";
import { CappedText, drainTextStream, omittedMarker, type ToolDefinition } from "@vibe/shared";
import type { BackgroundJobs } from "./jobs.ts";
import { killTreeAndWait } from "./process-tree.ts";
import { annotateDenial, type SandboxPolicy, wrapCommand } from "../sandbox.ts";

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
  dangerouslyUnsandboxed: z
    .boolean()
    .optional()
    .describe(
      "Run OUTSIDE the OS sandbox. Only use when a command legitimately needs to write outside the workspace or reach the network and the sandbox blocks it. Requires an explicit approval (fails closed in headless/auto).",
    ),
});

const DEFAULT_TIMEOUT = 120_000;
/** Cap on the model-facing captured output (bounds memory during streaming). Kept
 * as head+tail rather than head-only: a failing build prints its error LAST, so
 * dropping the tail would hide exactly the line the model needs to see. */
const OUTPUT_CAP = 30_000;
/** After the process exits (or is killed), wait at most this long for the output
 * pumps to drain before returning anyway. A backgrounded child (`sleep 30 &`) or
 * a kill-missed grandchild can inherit the stdout/stderr pipe and hold it open
 * past the direct child's exit — without this bound the tool call would block on
 * `pump()` for as long as that child lives. */
const POST_EXIT_GRACE_MS = 5_000;

/** Build the bash tool. A shared job registry enables `background: true`; an
 * optional sandbox policy wraps every foreground spawn (unless the call opts out
 * with `dangerouslyUnsandboxed`, which the permission engine gates separately).
 * `postKillGraceMs` overrides the post-exit pump-drain deadline (exposed for tests). */
export function bashTool(
  jobs?: BackgroundJobs,
  sandbox?: SandboxPolicy,
  opts: { postKillGraceMs?: number } = {},
): ToolDefinition<z.infer<typeof Input>> {
  const postKillGraceMs = opts.postKillGraceMs ?? POST_EXIT_GRACE_MS;
  return {
    name: "bash",
    description:
      "Execute a shell command in the session working directory. Streams output and returns combined stdout/stderr and the exit code. Use background:true for long-running commands (build/watch/server) and poll with job_status.",
    inputSchema: Input,
    readOnly: false,
    concurrencySafe: false,
    async execute({ command, timeoutMs, background, dangerouslyUnsandboxed }, ctx) {
      if (background) {
        if (!jobs) {
          return { output: "Background execution is unavailable here.", isError: true };
        }
        const job = jobs.start(command, ctx.cwd, { dangerouslyUnsandboxed });
        return {
          output: `Started ${job.id} in the background. Poll with job_status({id:"${job.id}"}).`,
        };
      }

      // OS sandbox (defense-in-depth under the permission engine): wrap the base
      // argv unless the model explicitly opted out — which the permission engine
      // already forced through an explicit, fail-closed approval before we ran.
      const useSandbox = sandbox !== undefined && !dangerouslyUnsandboxed;
      const argv = useSandbox
        ? wrapCommand(sandbox, { cwd: ctx.cwd, command })
        : ["bash", "-lc", command];

      // NOTE: we do NOT hand Bun the abort signal. Bun's `signal` SIGTERMs only
      // the direct `bash` child; its grandchildren (node/vite under `npm run
      // dev`) then reparent to PID 1 and leak, holding their port. We kill the
      // whole tree ourselves — while bash is still alive to be its children's
      // parent, so `pgrep -P` can still find them (a deferred kill after bash
      // exits would find nothing).
      const proc = Bun.spawn(argv, {
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

      // Start draining concurrently, then await the direct child's exit FIRST.
      // Once it has exited, race the pumps against a grace deadline: if a
      // backgrounded/leaked grandchild is still holding the pipe, we stop waiting
      // on it and return what we captured instead of hanging on `pump()`.
      const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
      let code: number;
      let pipeHeld = false;
      try {
        code = await proc.exited;
        const drained = await Promise.race([
          pumps.then(() => "done" as const),
          new Promise<"held">((r) => setTimeout(() => r("held"), postKillGraceMs)),
        ]);
        pipeHeld = drained === "held";
      } finally {
        clearTimeout(timer);
        ctx.abortSignal.removeEventListener("abort", onAbort);
      }

      const trimmed = out.toString();
      const status = timedOut
        ? `timed out after ${limit}ms (process killed; rerun with a larger timeoutMs or background:true)`
        : `exit ${code}`;
      const heldNote = pipeHeld
        ? "\n[a background child is still holding stdout/stderr — returning output captured so far; use background:true for long-running processes]"
        : "";
      const raw = `${status}${heldNote}\n${trimmed || "(no output)"}`;
      // On a sandboxed failure, append one actionable line if the output carries
      // a kernel-denial signature (no-op otherwise, so ordinary failures are
      // untouched).
      const output = useSandbox ? annotateDenial(raw, code, sandbox) : raw;
      return {
        output,
        isError: timedOut || code !== 0,
      };
    },
  };
}
