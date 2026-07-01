import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@vibe/shared";
import { unifiedDiff } from "../diff.ts";
import { withFileLock } from "../toolset.ts";
import { assertFresh, recordSeen } from "./freshness.ts";

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
      const exists = await file.exists();
      // Stale-write guard: only for an EXISTING file this session read earlier.
      // Creating/overwriting a file the session never read stays allowed (the
      // common write-new-file / blind-generate flow). Checked inside the lock.
      if (exists && assertFresh(ctx.sessionId, full).stale) {
        return {
          output: `${path} changed on disk since you last read it (external edit?). Re-read it first, then re-apply your change.`,
          isError: true,
        };
      }
      const before = exists ? await file.text() : "";
      await mkdir(dirname(full), { recursive: true });
      await Bun.write(full, content);
      // Advance the freshness baseline to our own write's mtime so a later edit
      // in this session doesn't mistake our write for an external change.
      recordSeen(ctx.sessionId, full);

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
      const diag = await ctx.diagnose?.(full).catch(() => undefined);
      return { output: `${verb} ${path} (+${diff.added} -${diff.removed})${diag ? `\n\n${diag}` : ""}` };
    });
  },
};
