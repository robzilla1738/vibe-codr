import { Glob } from "bun";
import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

const Input = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "**/*.ts".'),
  cwd: z.string().optional().describe("Directory to search, relative to cwd."),
});

export const globTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "glob",
  description:
    "Find files by glob pattern. Returns matching paths relative to the search directory.",
  inputSchema: Input,
  readOnly: true,
  concurrencySafe: true,
  async execute({ pattern, cwd }, ctx) {
    const searchDir = cwd ? `${ctx.cwd}/${cwd}` : ctx.cwd;
    const LIMIT = 1000;
    const glob = new Glob(pattern);
    const matches: string[] = [];
    let truncated = false;
    for await (const file of glob.scan({ cwd: searchDir, dot: false })) {
      matches.push(file);
      // Probe for one MORE than the cap so a directory with exactly `LIMIT`
      // matches isn't falsely flagged truncated (the old `>= LIMIT` broke early).
      if (matches.length > LIMIT) {
        truncated = true;
        break;
      }
    }
    if (!matches.length) return { output: "(no matches)" };
    const shown = matches.slice(0, LIMIT);
    const note = truncated
      ? `\n…(truncated at ${LIMIT} matches; narrow the pattern)`
      : "";
    return { output: shown.join("\n") + note };
  },
};
