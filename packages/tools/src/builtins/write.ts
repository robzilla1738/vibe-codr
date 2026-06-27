import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

const Input = z.object({
  path: z.string().describe("File path to write, relative to cwd."),
  content: z.string().describe("Full file contents."),
});

export const writeTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "write",
  description:
    "Create or overwrite a file with the given contents. Parent directories are created automatically.",
  inputSchema: Input,
  readOnly: false,
  concurrencySafe: false,
  async execute({ path, content }, ctx) {
    const full = resolve(ctx.cwd, path);
    await mkdir(dirname(full), { recursive: true });
    await Bun.write(full, content);
    return { output: `Wrote ${content.length} bytes to ${path}` };
  },
};
