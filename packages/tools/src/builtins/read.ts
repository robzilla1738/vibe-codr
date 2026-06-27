import { resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

const Input = z.object({
  path: z.string().describe("File path, absolute or relative to the cwd."),
  offset: z.number().int().min(0).optional().describe("0-based start line."),
  limit: z.number().int().positive().optional().describe("Max lines to read."),
});

export const readTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "read",
  description:
    "Read a text file from the local filesystem. Returns line-numbered content. Supports optional line offset/limit for large files.",
  inputSchema: Input,
  readOnly: true,
  concurrencySafe: true,
  async execute({ path, offset, limit }, ctx) {
    const file = Bun.file(resolve(ctx.cwd, path));
    if (!(await file.exists())) {
      return { output: `File not found: ${path}`, isError: true };
    }
    const text = await file.text();
    const lines = text.split("\n");
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : lines.length;
    const body = lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join("\n");
    return { output: body || "(empty file)" };
  },
};
