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
    // `--` terminates option parsing so a pattern/path beginning with `-`
    // (e.g. "-->", "--foo") is treated as a search term, not a ripgrep flag.
    args.push("--", pattern, path ?? ".");
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
      const LIMIT = 500;
      // ripgrep output ends with a trailing newline; drop the empty tail so the
      // count reflects real match lines before deciding whether we truncated.
      const lines = out.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const truncated = lines.length > LIMIT;
      const capped = lines.slice(0, LIMIT).join("\n");
      if (!capped) return { output: "(no matches)" };
      return {
        output: truncated ? `${capped}\n…(truncated at ${LIMIT} matches)` : capped,
      };
    } catch (err) {
      return {
        output: `grep unavailable (is ripgrep installed?): ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
