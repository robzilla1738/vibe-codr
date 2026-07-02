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
    // The model has now seen this file's on-disk state; record its mtime so a
    // later edit/write can detect an external change since this read (stale-write
    // guard). Recorded for empty/truncated reads too — the model still saw them.
    recordSeen(ctx.sessionId, full);

    // Stream the file and apply offset/limit + the char cap WITHOUT slurping the
    // whole thing into memory: `read({limit:10})` on a multi-GB log must not OOM
    // (the old `await file.text()` loaded everything before slicing). We retain
    // at most ~MAX_OUTPUT chars, stop reading once the window/cap is satisfied,
    // and preserve `split("\n")` line semantics exactly (a trailing segment — even
    // an empty one after a final newline — is its own 1-based line).
    const start = offset ?? 0;
    const endLine = limit !== undefined ? start + limit : Number.POSITIVE_INFINITY;

    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let lineIdx = 0; // 0-based index of the line currently being assembled
    let cur = ""; // retained (bounded) chars of the current line
    let inWindow = start <= 0 && endLine > 0;
    let body = "";
    let capped = false; // body exceeded MAX_OUTPUT — stop emitting
    let stop = false; // stop reading entirely
    let bytes = 0;
    let binary = false;

    const finishLine = (): void => {
      if (inWindow && !capped) {
        const rendered = `${lineIdx + 1}\t${cur}`;
        body += body ? `\n${rendered}` : rendered;
        if (body.length > MAX_OUTPUT) capped = true;
      }
      lineIdx++;
      inWindow = lineIdx >= start && lineIdx < endLine;
      cur = "";
      if (capped || lineIdx >= endLine) stop = true;
    };

    const appendToCur = (seg: string): void => {
      if (!inWindow || capped || stop || !seg) return;
      cur += seg;
      // Once this in-window line alone overflows the cap, no later content can
      // matter — emit the (bounded) line and stop reading (guards a multi-GB
      // single line: `cur` never grows past ~MAX_OUTPUT + one stream chunk).
      if (body.length + cur.length > MAX_OUTPUT) {
        finishLine();
        stop = true;
      }
    };

    try {
      while (!stop) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.length;
        // A NUL anywhere in the bytes we actually read means binary — the 4096-
        // byte head sniff misses a NUL that first appears deeper in the file.
        if (value.includes(0)) {
          binary = true;
          break;
        }
        const chunk = decoder.decode(value, { stream: true });
        let pos = 0;
        while (pos < chunk.length) {
          const nl = chunk.indexOf("\n", pos);
          if (nl === -1) {
            appendToCur(chunk.slice(pos));
            break;
          }
          appendToCur(chunk.slice(pos, nl));
          finishLine();
          pos = nl + 1;
          if (stop) break;
        }
      }
      if (!stop && !binary) {
        appendToCur(decoder.decode()); // flush any trailing multibyte remainder
        // The segment after the last newline is its own line (split semantics).
        finishLine();
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    if (binary) {
      return {
        output: `Cannot read ${path}: it appears to be a binary file.`,
        isError: true,
      };
    }
    if (bytes === 0) return { output: "(empty file)" };
    const totalLines = lineIdx;
    // A non-empty file read entirely past its end is a paging mistake worth
    // flagging, not a silent "(empty file)".
    if (start > 0 && start >= totalLines) {
      return {
        output: `offset ${start} is past the end of ${path} (${totalLines} lines).`,
        isError: true,
      };
    }
    if (body.length > MAX_OUTPUT) {
      body = `${body.slice(0, MAX_OUTPUT)}\n…(truncated at ${MAX_OUTPUT} chars; use offset/limit to page)`;
    }
    return { output: body };
  },
};
