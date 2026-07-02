import { resolve, dirname } from "node:path";
import { mkdir, rename, chmod, rm } from "node:fs/promises";
import { statSync, lstatSync, realpathSync } from "node:fs";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@vibe/shared";
import { unifiedDiff } from "../diff.ts";
import { withFileLock } from "../toolset.ts";
import { assertFresh, recordSeen } from "./freshness.ts";

/** Monotonic per-process counter for unique temp names (paired with the pid), so
 * two concurrent writers never collide on one temp path. */
let writeSeq = 0;

/**
 * Dereference a symlink to the real file it points at. Temp+rename swaps the inode
 * AT the given path, so renaming over a symlink would replace the LINK with a
 * regular file and strand its target byte-for-byte stale. Writing THROUGH a link
 * must instead update the target in place, so we resolve it and land the atomic
 * swap on the real path (its temp sits beside it, staying on one filesystem).
 * `lstat` (not `stat`) so the link is detected rather than followed; a non-symlink
 * — or a path that doesn't exist yet (a fresh create) — is returned unchanged.
 */
function derefSymlink(full: string): string {
  try {
    if (lstatSync(full).isSymbolicLink()) return realpathSync(full);
  } catch {
    // Nothing at `full` (or an unreadable link) — nothing to dereference.
  }
  return full;
}

/**
 * Write `full` ATOMICALLY: a per-write-unique temp in the SAME directory (rename
 * is atomic only within one filesystem), then rename over the target. A crash
 * mid-write leaves the ORIGINAL intact (torn bytes stay in the temp) instead of a
 * truncated file, and on any failure we unlink our own temp and re-throw. When
 * overwriting, the original's mode is carried onto the temp so the rename doesn't
 * silently reset perms (an executable stays +x); a brand-new file (`mode`
 * undefined) keeps the umask default a direct create would have given it. Mirrors
 * the session store's temp+rename discipline.
 */
async function atomicReplace(full: string, data: string, mode: number | undefined): Promise<void> {
  const target = derefSymlink(full);
  const tmp = `${target}.${process.pid}.${writeSeq++}.tmp`;
  try {
    await Bun.write(tmp, data);
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

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
      // Temp+rename so a crash can't leave a truncated file (see atomicReplace);
      // preserve an existing file's mode, default umask for a fresh create.
      await atomicReplace(full, content, exists ? statSync(full).mode : undefined);
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
