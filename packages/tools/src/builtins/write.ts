import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@vibe/shared";
import { unifiedDiff } from "../diff.ts";
import { withFileLock } from "../toolset.ts";
import { atomicReplace } from "../fs/atomic.ts";
import { readTextIfExists } from "../fs/safe-read.ts";

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
    // Per-tree stale-write guard (engine-owned `FreshnessRegistry`, required
    // on `ctx.freshness`). One per Session tree so a long-running tree's
    // records are bounded by finalize(), and so two engines in the same worker
    // process can't observe each other's tracking.
    const freshness = ctx.freshness;

    // Serialize against concurrent subagents writing the same path (cross-tree).
    return withFileLock(ctx, full, async () => {
      // Single atomic read — the C-2 fix. The previous shape
      // (`await file.exists()` then `await file.text()`) was a TOCTOU: an
      // external delete between the two calls threw ENOENT mid-write. The
      // helper does ONE Bun.file().text() (Bun's native FD lifecycle is
      // already race-free against unlink), maps ENOENT → null, and propagates
      // every other error so a forbidden file is never silently overwritten.
      const before = (await readTextIfExists(full)) ?? "";
      // Stale-write guard: only for a file this session read earlier. The
      // "" sentinel is "we just observed a fresh-create (or the file was
      // concurrently deleted right before our read)"; either way, no prior
      // mtime baseline to compare against, so the guard is a no-op.
      if (before !== "" && freshness.assertFresh(ctx.sessionId, full).stale) {
        return {
          output: `${path} changed on disk since you last read it (external edit?). Re-read it first, then re-apply your change.`,
          isError: true,
        };
      }
      await mkdir(dirname(full), { recursive: true });
      // Temp+rename so a crash can't leave a truncated file. atomicReplace
      // captures the target's mode INTERNALLY on the post-deref `target` —
      // capturing it here at `full` would race an external symlink-swap or
      // chmod (bug2.md C-1), and the previous exists/statSync shape raced an
      // external delete (bug2.md C-2). Both are closed by construction.
      await atomicReplace(full, content);
      // Advance the freshness baseline to our own write's mtime so a later edit
      // in this session doesn't mistake our write for an external change.
      freshness.recordWrite(ctx.sessionId, full);

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
