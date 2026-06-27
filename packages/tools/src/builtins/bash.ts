import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

const Input = z.object({
  command: z.string().describe("Shell command to execute."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Timeout in ms (default 120000)."),
});

const DEFAULT_TIMEOUT = 120_000;

export const bashTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "bash",
  description:
    "Execute a shell command in the session working directory. Streams output and returns combined stdout/stderr and the exit code.",
  inputSchema: Input,
  readOnly: false,
  concurrencySafe: false,
  async execute({ command, timeoutMs }, ctx) {
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      signal: ctx.abortSignal,
    });

    const timer = setTimeout(() => {
      proc.kill();
    }, timeoutMs ?? DEFAULT_TIMEOUT);

    const decoder = new TextDecoder();
    let out = "";
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk);
        out += text;
        ctx.emit({
          type: "tool-call-progress",
          sessionId: ctx.sessionId,
          toolCallId: ctx.toolCallId,
          chunk: text,
        });
      }
    };

    await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    const code = await proc.exited;
    clearTimeout(timer);

    const trimmed = out.length > 30_000 ? `${out.slice(0, 30_000)}\n…(truncated)` : out;
    return {
      output: `exit ${code}\n${trimmed || "(no output)"}`,
      isError: code !== 0,
    };
  },
};
