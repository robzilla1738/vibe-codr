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
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run an editor process to completion with the terminal inherited. Rejects only
 * on a spawn failure (missing binary); a non-zero editor exit still resolves
 * (the file is read back regardless — that's how `git commit` treats `:cq`-less
 * exits). */
export type EditorSpawn = (command: string, args: string[]) => Promise<void>;

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
  const write = deps.writeText ?? ((p, t) => writeFile(p, t, "utf8"));
  const read = deps.readText ?? ((p) => readFile(p, "utf8"));
  const remove = deps.removeFile ?? ((p) => rm(p, { force: true }));

  await write(path, deps.draft);
  try {
    await deps.spawn(command, [...args, path]);
  } catch (err) {
    await remove(path).catch(() => {});
    return { kind: "failed", reason: (err as Error).message };
  }

  let contents: string;
  try {
    contents = await read(path);
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
