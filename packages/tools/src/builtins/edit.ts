import { resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

const Input = z.object({
  path: z.string().describe("File to edit, relative to cwd."),
  oldString: z.string().describe("Exact text to replace (must be unique)."),
  newString: z.string().describe("Replacement text."),
});

export const editTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "edit",
  description:
    "Replace an exact, unique substring in a file. Fails if the old string is missing or appears more than once.",
  inputSchema: Input,
  readOnly: false,
  concurrencySafe: false,
  async execute({ path, oldString, newString }, ctx) {
    const full = resolve(ctx.cwd, path);
    const file = Bun.file(full);
    if (!(await file.exists())) {
      return { output: `File not found: ${path}`, isError: true };
    }
    const text = await file.text();
    const occurrences = text.split(oldString).length - 1;
    if (occurrences === 0) {
      return { output: `oldString not found in ${path}`, isError: true };
    }
    if (occurrences > 1) {
      return {
        output: `oldString appears ${occurrences} times in ${path}; make it unique`,
        isError: true,
      };
    }
    await Bun.write(full, text.replace(oldString, newString));
    return { output: `Edited ${path}` };
  },
};
