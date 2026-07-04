import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

const Input = z.object({
  path: z.string().optional().describe("Directory to list (default: cwd)."),
});

/** Cap the entry list like grep/glob do — a directory of hundreds of thousands
 * of entries (node_modules, a generated-asset dir, an adversarial repo) would
 * otherwise flood the whole list into the context window in one shot. */
const LIMIT = 1000;

export const lsTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "ls",
  description: "List the entries of a directory (files and subdirectories).",
  inputSchema: Input,
  readOnly: true,
  concurrencySafe: true,
  async execute({ path }, ctx) {
    const dir = resolve(ctx.cwd, path ?? ".");
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const lines = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      if (!lines.length) return { output: "(empty directory)" };
      if (lines.length > LIMIT) {
        const shown = lines.slice(0, LIMIT);
        return {
          output: `${shown.join("\n")}\n…(${lines.length - LIMIT} more entries truncated at ${LIMIT}; use glob/grep to filter)`,
        };
      }
      return { output: lines.join("\n") };
    } catch (err) {
      return { output: `Cannot list ${path ?? "."}: ${(err as Error).message}`, isError: true };
    }
  },
};
