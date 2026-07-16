/**
 * Compose the current draft in `$VISUAL`/`$EDITOR`: write the draft to a temp
 * file, run the editor on it (stdio inherited so it owns the terminal), then read
 * the file back as the new draft. The TUI suspends/resumes the renderer around
 * the call (see app.tsx) so the child has the raw terminal to itself.
 *
 * Cancel semantics: an EMPTY file on exit keeps the prior draft (the user backed
 * out); a non-empty file REPLACES it. The temp round-trip is pure over an
 * injectable `spawn` seam so it's unit-testable without a real editor.
 */

import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run an editor process to completion with the terminal inherited. Resolves
 * with the process exit code. Rejects only on a spawn failure (missing binary).
 * Non-zero exit is returned so composeInEditor can keep the prior draft (BUG-080). */
export type EditorSpawn = (command: string, args: string[]) => Promise<number>;

export type EditorComposeResult =
  /** A non-empty file came back — use it as the new draft. */
  | { kind: "replaced"; draft: string }
  /** The file was empty on exit — keep the prior draft. */
  | { kind: "kept" }
  /** Neither `$VISUAL` nor `$EDITOR` is set — nothing to launch. */
  | { kind: "unavailable" }
  /** The editor couldn't be launched (bad command). */
  | { kind: "failed"; reason: string };

export interface EditorComposeDeps {
  /** The editor command line (`$VISUAL || $EDITOR`), possibly with flags. */
  editor: string | undefined;
  /** The current draft to seed the file with. */
  draft: string;
  spawn: EditorSpawn;
  /** Overrides for testing; default to real tmp-file fs ops. */
  outPath?: string;
  readText?: (path: string) => Promise<string>;
  writeText?: (path: string, text: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
}

/** Match the main-process IPC ceiling. An editor may replace the temp file
 * with anything, so both stat-before-read and byte-after-read are required. */
export const EDITOR_DRAFT_MAX_BYTES = 2 * 1024 * 1024;

async function readEditorDraft(path: string): Promise<string> {
  const file = await stat(path);
  if (file.size > EDITOR_DRAFT_MAX_BYTES) {
    throw new Error(`Editor draft exceeds ${EDITOR_DRAFT_MAX_BYTES} bytes`);
  }
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content, "utf8") > EDITOR_DRAFT_MAX_BYTES) {
    throw new Error(`Editor draft exceeds ${EDITOR_DRAFT_MAX_BYTES} bytes`);
  }
  return content;
}

/**
 * Split an editor command line into the binary + its args (`"code -w"` →
 * `["code", "-w"]`). Whitespace-only splitting — good enough for the standard
 * `$EDITOR` forms (`vim`, `nvim`, `code -w`, `emacsclient -nw`); a path with
 * embedded spaces is not supported (neither is it by most tools that read
 * `$EDITOR`).
 */
export function parseEditorCommand(editor: string): { command: string; args: string[] } {
  const parts = editor.trim().split(/\s+/).filter(Boolean);
  return { command: parts[0] ?? "", args: parts.slice(1) };
}

/**
 * Round-trip the draft through the editor. Writes `draft` to a temp file, runs
 * the editor on it, reads it back. Cleans up the temp file (best-effort). Never
 * throws for the expected cases — returns a discriminated result the caller turns
 * into a notice or a draft replacement.
 */
export async function composeInEditor(deps: EditorComposeDeps): Promise<EditorComposeResult> {
  if (!deps.editor?.trim()) return { kind: "unavailable" };
  const { command, args } = parseEditorCommand(deps.editor);
  if (!command) return { kind: "unavailable" };

  const path = deps.outPath ?? join(tmpdir(), `vibe-compose-${randomUUID()}.md`);
  const write = deps.writeText ?? ((p, t) => writeFile(p, t, { encoding: "utf8", mode: 0o600 }));
  const read = deps.readText ?? readEditorDraft;
  const remove = deps.removeFile ?? ((p) => rm(p, { force: true }));

  // Honor the "never throws for the expected cases" contract: a failed temp
  // write (unwritable/full $TMPDIR) becomes a `failed` result, not a throw.
  try {
    await write(path, deps.draft);
  } catch (err) {
    return { kind: "failed", reason: (err as Error).message };
  }
  let exitCode = 0;
  try {
    exitCode = await deps.spawn(command, [...args, path]);
  } catch (err) {
    await remove(path).catch(() => {});
    return { kind: "failed", reason: (err as Error).message };
  }

  // BUG-080: non-zero exit (editor abort / :cq) keeps the prior draft.
  if (exitCode !== 0) {
    await remove(path).catch(() => {});
    return { kind: "kept" };
  }

  let contents: string;
  try {
    contents = await read(path);
    // Keep injected/test readers under the same production contract.
    if (Buffer.byteLength(contents, "utf8") > EDITOR_DRAFT_MAX_BYTES) {
      throw new Error(`Editor draft exceeds ${EDITOR_DRAFT_MAX_BYTES} bytes`);
    }
  } catch (err) {
    return { kind: "failed", reason: (err as Error).message };
  } finally {
    await remove(path).catch(() => {});
  }

  // Strip a single trailing newline (editors append one) so the draft isn't
  // submitted with a stray blank line; an otherwise-empty file keeps the draft.
  const next = contents.replace(/\n$/, "");
  if (!next.trim()) return { kind: "kept" };
  return { kind: "replaced", draft: next };
}
