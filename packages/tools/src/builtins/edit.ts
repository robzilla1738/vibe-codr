import { resolve } from "node:path";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@vibe/shared";
import { unifiedDiff } from "../diff.ts";
import { withFileLock } from "../toolset.ts";
import { atomicReplace } from "../fs/atomic.ts";
import { readBytesIfExists } from "../fs/safe-read.ts";
import { withPathAliases } from "../path-input.ts";

const SingleEdit = z.object({
  oldString: z.string().describe("Exact text to replace."),
  newString: z.string().describe("Replacement text."),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring a unique match."),
});

const Input = withPathAliases({
  path: z.string().describe("File to edit, relative to cwd."),
  oldString: z
    .string()
    .optional()
    .describe("Exact text to replace (single-edit form; must be unique unless replaceAll)."),
  newString: z.string().optional().describe("Replacement text (single-edit form)."),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Single-edit form: replace every occurrence instead of requiring a unique match."),
  edits: z
    .array(SingleEdit)
    .optional()
    .describe(
      "Multiple edits applied in order and atomically (all-or-nothing). Use instead of the single oldString/newString.",
    ),
});

type EditOp = z.infer<typeof SingleEdit>;

/** Apply one edit to `text`, returning the new text or an error message. */
function applyOne(text: string, edit: EditOp): { text: string } | { error: string } {
  const { oldString, newString, replaceAll } = edit;
  if (oldString === "") {
    return { error: "oldString must not be empty" };
  }
  const occurrences = text.split(oldString).length - 1;
  if (occurrences === 0) {
    return { error: `oldString not found: ${JSON.stringify(truncate(oldString))}` };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      error: `oldString appears ${occurrences} times; pass replaceAll or make it unique: ${JSON.stringify(
        truncate(oldString),
      )}`,
    };
  }
  // Use a function replacer for the single-replace branch so `$`-sequences in
  // newString (`$&`, `$1`, `$$`) are inserted literally rather than interpreted
  // as String.replace special patterns. (split/join is already literal.)
  const next = replaceAll
    ? text.split(oldString).join(newString)
    : text.replace(oldString, () => newString);
  return { text: next };
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Cap the diff embedded in the model-facing output. Like every other
 * context-producing tool, `edit` must not return an unbounded blob — a large
 * `replaceAll` or multi-edit on a big file would otherwise dump the whole diff
 * verbatim into the prompt and defeat the engine's context accounting. The UI
 * still gets the full diff via the `file-changed` event; only the model's copy
 * (a confirmation aid) is bounded. Caps at the same 20k as `git_diff`.
 */
function capDiff(s: string, max = 20_000): string {
  return s.length > max
    ? `${s.slice(0, max)}\n…(diff truncated at ${max} chars)`
    : s;
}

type EditInput = z.output<typeof Input>;

export const editTool: ToolDefinition<EditInput> = {
  name: "edit",
  description:
    "Edit a file by replacing exact text. Single edit: pass oldString/newString (add replaceAll for non-unique matches). Multiple edits: pass an `edits` array, applied atomically (all-or-nothing). Returns a unified diff of the change.",
  inputSchema: Input,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx: ToolContext) {
    const { path } = input;
    const full = resolve(ctx.cwd, path);

    // Normalize to a list of edits (single-edit form is sugar for one entry).
    const ops: EditOp[] = input.edits?.length
      ? input.edits
      : input.oldString !== undefined
        ? [
            {
              oldString: input.oldString,
              newString: input.newString ?? "",
              replaceAll: input.replaceAll,
            },
          ]
        : [];
    if (ops.length === 0) {
      return {
        output: "Provide either oldString/newString or a non-empty edits array.",
        isError: true,
      };
    }

    // Per-tree stale-write guard (engine-owned `FreshnessRegistry`, required
    // on `ctx.freshness`). One per Session tree so a long-running tree's
    // records are bounded by finalize(), and so two engines in the same worker
    // process can't observe each other's tracking.
    const freshness = ctx.freshness;

    // Serialize the whole read-modify-write on this path so a concurrent
    // subagent editing the same file can't clobber our change (cross-tree lock).
    return withFileLock(ctx, full, async () => {
      // Single atomic read of the RAW bytes — the C-2 fix. The previous shape
      // (`await file.exists()` then `await file.arrayBuffer()`) was a TOCTOU
      // AND misdiagnosed a deleted file as "looks binary" because the
      // ENOENT from the arrayBuffer() call landed in the TextDecoder catch
      // arm. readBytesIfExists is one atomic step: it returns null on
      // ENOENT (we say "File not found"), raw bytes on success, throws on
      // any other error (EACCES, EISDIR) so a real failure isn't swallowed.
      const rawBytes = await readBytesIfExists(full);
      if (rawBytes === null) {
        return { output: `File not found: ${path}`, isError: true };
      }

      // Stale-write guard: if this session read the file earlier and it changed
      // on disk since (an external edit), refuse — oldString might still match a
      // now-outdated view and silently clobber someone else's change. Checked
      // INSIDE the lock so a concurrent subagent's write can't slip in between
      // this check and our read-modify-write.
      if (freshness.assertFresh(ctx.sessionId, full).stale) {
        return {
          output: `${path} changed on disk since you last read it (external edit?). Re-read it first, then re-apply your change.`,
          isError: true,
        };
      }

      // Strict-decode the RAW bytes (not the lossy text) so any invalid-UTF-8
      // byte is caught here instead of being silently mapped to U+FFFD by
      // Bun.file().text(). The lossy path would round-trip 0xFF → U+FFFD →
      // 0xEF 0xBF 0xBD and persist that corruption far from the edited
      // region while reporting success — the literal pre-C-2 corruption bug.
      // ENOENT cannot reach this decode because readBytesIfExists already
      // returned null in that case.
      let before: string;
      try {
        before = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
      } catch {
        return {
          output: `${path} is not valid UTF-8 (looks binary) — refusing to edit, since a text edit would corrupt its bytes. Use a different tool for binary files.`,
          isError: true,
        };
      }
      // Apply against an in-memory buffer; write only if every edit succeeds.
      let buffer = before;
      for (let i = 0; i < ops.length; i++) {
        const result = applyOne(buffer, ops[i] as EditOp);
        if ("error" in result) {
          return {
            output: `Edit ${i + 1}/${ops.length} failed in ${path}: ${result.error}. No changes written.`,
            isError: true,
          };
        }
        buffer = result.text;
      }

      if (buffer === before) {
        return { output: `No changes: replacement matched existing content in ${path}.` };
      }

      // Temp+rename so a crash can't leave a truncated file. atomicReplace
      // captures the target's mode INTERNALLY on the post-deref `target` —
      // capturing it here at `full` would race an external symlink-swap
      // or chmod and could land the wrong mode on the wrong inode (bug2.md
      // C-1). A missing target falls back to umask-default; the file just
      // verified-exists covers the "existing target" path cleanly.
      await atomicReplace(full, buffer);
    // Advance the freshness baseline to our own write's mtime so the next edit
    // in this session doesn't mistake our change for an external one.
    freshness.recordWrite(ctx.sessionId, full);
      const diff = unifiedDiff(before, buffer);
      ctx.emit({
        type: "file-changed",
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        path,
        action: "edit",
        diff: diff.text,
        added: diff.added,
        removed: diff.removed,
      });
      // Compiler feedback in the SAME step: when core wired a language service,
      // fresh diagnostics for the edited file ride along with the diff.
      const diag = await ctx.diagnose?.(full).catch(() => undefined);
      // A change confined to the trailing newline (or other line-terminator-only
      // edit) leaves the line-based diff empty, so `+0 -0` would misreport a real
      // byte change as a no-op — say so explicitly instead.
      const summary =
        diff.added === 0 && diff.removed === 0
          ? `Edited ${path} (trailing-newline / whitespace change; no line-level diff)`
          : `Edited ${path} (+${diff.added} -${diff.removed})\n${capDiff(diff.text)}`;
      return { output: `${summary}${diag ? `\n\n${diag}` : ""}` };
    });
  },
};
