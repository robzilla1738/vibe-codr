import { resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";
import { recordSeen } from "./freshness.ts";

const Input = z.object({
  path: z.string().describe("File path, absolute or relative to the cwd."),
  offset: z.number().int().min(0).optional().describe("0-based start line."),
  limit: z.number().int().positive().optional().describe("Max lines to read."),
});

/** Cap on the returned content. Like grep/git/webfetch, read never dumps an
 * unbounded blob into the context window — a minified bundle or a file with a
 * single multi-megabyte line is truncated with an explicit marker. */
const MAX_OUTPUT = 100_000;

export const readTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "read",
  description:
    "Read a text file from the local filesystem. Returns line-numbered content. Supports optional line offset/limit for large files.",
  inputSchema: Input,
  readOnly: true,
  concurrencySafe: true,
  async execute({ path, offset, limit }, ctx) {
    const full = resolve(ctx.cwd, path);
    const file = Bun.file(full);
    if (!(await file.exists())) {
      return { output: `File not found: ${path}`, isError: true };
    }
    // Sniff the leading bytes for a NUL — present in binary files, never in
    // valid UTF-8 text — and refuse rather than flood the context with thousands
    // of mojibake tokens (an image, an executable, a compiled artifact).
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (head.includes(0)) {
      return {
        output: `Cannot read ${path}: it appears to be a binary file.`,
        isError: true,
      };
    }
    const text = await file.text();
    // The model has now seen this file's on-disk state; record its mtime so a
    // later edit/write can detect an external change since this read (stale-write
    // guard). Recorded for empty/truncated reads too — the model still saw them.
    recordSeen(ctx.sessionId, full);
    if (text === "") return { output: "(empty file)" };
    const lines = text.split("\n");
    const start = offset ?? 0;
    // A non-empty file read entirely past its end is a paging mistake worth
    // flagging, not a silent "(empty file)".
    if (start > 0 && start >= lines.length) {
      return {
        output: `offset ${start} is past the end of ${path} (${lines.length} lines).`,
        isError: true,
      };
    }
    const end = limit !== undefined ? start + limit : lines.length;
    let body = lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join("\n");
    if (body.length > MAX_OUTPUT) {
      body = `${body.slice(0, MAX_OUTPUT)}\n…(truncated at ${MAX_OUTPUT} chars; use offset/limit to page)`;
    }
    return { output: body };
  },
};
