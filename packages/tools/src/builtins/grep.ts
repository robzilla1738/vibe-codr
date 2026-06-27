import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

const Input = z.object({
  pattern: z.string().describe("Regex pattern to search for."),
  path: z.string().optional().describe("Directory or file to search."),
  glob: z.string().optional().describe('Filter files by glob, e.g. "*.ts".'),
});

export const grepTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "grep",
  description:
    "Search file contents by regex using ripgrep. Returns matching lines with file:line prefixes.",
  inputSchema: Input,
  readOnly: true,
  concurrencySafe: true,
  async execute({ pattern, path, glob }, ctx) {
    const args = ["rg", "--line-number", "--no-heading", "--color", "never"];
    if (glob) args.push("--glob", glob);
    args.push(pattern, path ?? ".");
    try {
      const proc = Bun.spawn(args, {
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
        signal: ctx.abortSignal,
      });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code === 1) return { output: "(no matches)" };
      if (code > 1) {
        const err = await new Response(proc.stderr).text();
        return { output: `ripgrep error: ${err}`, isError: true };
      }
      const capped = out.split("\n").slice(0, 500).join("\n");
      return { output: capped || "(no matches)" };
    } catch (err) {
      return {
        output: `grep unavailable (is ripgrep installed?): ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
