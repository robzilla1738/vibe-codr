import { resolve } from "node:path";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@vibe/shared";
import { unifiedDiff } from "../diff.ts";

const SingleEdit = z.object({
  oldString: z.string().describe("Exact text to replace."),
  newString: z.string().describe("Replacement text."),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring a unique match."),
});

const Input = z.object({
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
  const next = replaceAll
    ? text.split(oldString).join(newString)
    : text.replace(oldString, newString);
  return { text: next };
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export const editTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "edit",
  description:
    "Edit a file by replacing exact text. Single edit: pass oldString/newString (add replaceAll for non-unique matches). Multiple edits: pass an `edits` array, applied atomically (all-or-nothing). Returns a unified diff of the change.",
  inputSchema: Input,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx: ToolContext) {
    const { path } = input;
    const full = resolve(ctx.cwd, path);
    const file = Bun.file(full);
    if (!(await file.exists())) {
      return { output: `File not found: ${path}`, isError: true };
    }

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

    const before = await file.text();
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

    await Bun.write(full, buffer);
    const diff = unifiedDiff(before, buffer);
    ctx.emit({
      type: "file-changed",
      sessionId: ctx.sessionId,
      path,
      action: "edit",
      diff: diff.text,
      added: diff.added,
      removed: diff.removed,
    });
    return {
      output: `Edited ${path} (+${diff.added} -${diff.removed})\n${diff.text}`,
    };
  },
};
