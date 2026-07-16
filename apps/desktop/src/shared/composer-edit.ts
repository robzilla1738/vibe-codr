import { formatAtPath } from "./file-fuzzy";

export interface ComposerEdit {
  value: string;
  caret: number;
}

/** Insert native clipboard text or an @file image token at the current selection. */
export function applyComposerPaste(
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  paste: { kind: "text"; text: string } | { kind: "image"; path: string },
): ComposerEdit {
  const start = Math.max(0, Math.min(selectionStart, draft.length));
  const end = Math.max(start, Math.min(selectionEnd, draft.length));
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  if (paste.kind === "text") {
    return {
      value: `${before}${paste.text}${after}`,
      caret: before.length + paste.text.length,
    };
  }

  const leading = before && !/\s$/.test(before) ? " " : "";
  // Match the TUI: leave the caret after a separating space so typing can resume.
  const trailing = after && /^\s/.test(after) ? "" : " ";
  const inserted = `${leading}${formatAtPath(paste.path)}${trailing}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}
