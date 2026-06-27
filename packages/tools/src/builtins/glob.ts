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
    const glob = new Glob(pattern);
    const matches: string[] = [];
    for await (const file of glob.scan({ cwd: searchDir, dot: false })) {
      matches.push(file);
      if (matches.length >= 1000) break;
    }
    return {
      output: matches.length ? matches.join("\n") : "(no matches)",
    };
  },
};
