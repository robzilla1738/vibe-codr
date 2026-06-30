import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@vibe/shared";
import { unifiedDiff } from "../diff.ts";
import { withFileLock } from "../toolset.ts";

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
  async execute({ path, content }, ctx: ToolContext) {
    const full = resolve(ctx.cwd, path);
    // Serialize against concurrent subagents writing the same path (cross-tree).
    return withFileLock(ctx, full, async () => {
      const file = Bun.file(full);
      const before = (await file.exists()) ? await file.text() : "";
      await mkdir(dirname(full), { recursive: true });
      await Bun.write(full, content);

      const diff = unifiedDiff(before, content);
      ctx.emit({
        type: "file-changed",
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        path,
        action: "write",
        diff: diff.text,
        added: diff.added,
        removed: diff.removed,
      });
      const verb = before === "" ? "Created" : "Overwrote";
      return { output: `${verb} ${path} (+${diff.added} -${diff.removed})` };
    });
  },
};
