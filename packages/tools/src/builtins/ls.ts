import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

const Input = z.object({
  path: z.string().optional().describe("Directory to list (default: cwd)."),
});

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
      return { output: lines.length ? lines.join("\n") : "(empty directory)" };
    } catch (err) {
      return { output: `Cannot list ${path ?? "."}: ${(err as Error).message}`, isError: true };
    }
  },
};
