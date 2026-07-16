/**
 * Essential keyboard chords for /keys (and the /help tip).
 * Kept pure + tested so the discoverable surface never drifts from real bindings.
 */

export interface KeyChord {
  keys: string;
  action: string;
}

/** The short list that matters — not OpenCode's full leader map. */
export const ESSENTIAL_KEYS: readonly KeyChord[] = [
  { keys: "Shift+Tab", action: "Cycle mode (PLAN → AGENT → YOLO)" },
  { keys: "Esc", action: "Interrupt turn · deny permission · dismiss menu" },
  { keys: "Ctrl+O", action: "Fold / unfold all turns" },
  { keys: "Ctrl+T", action: "Expand / collapse all thinking rows" },
  { keys: "Ctrl+D", action: "Cycle transcript density (quiet → normal → verbose)" },
  { keys: "Ctrl+G", action: "Compose draft in $VISUAL / $EDITOR" },
  { keys: "⌘,", action: "Toggle settings panel" },
  { keys: "⌘⇧B", action: "Toggle git panel" },
  { keys: "Ctrl+V", action: "Paste clipboard image as @file" },
  { keys: "Ctrl+C", action: "Clear draft · quit gracefully when empty" },
  { keys: "y / a / Ctrl+P / n", action: "Permission: once · session · project · deny" },
  { keys: "Enter / type / Esc", action: "Plan: accept · revise · keep planning" },
  { keys: "/", action: "Slash commands (type to filter)" },
  { keys: "@", action: "Attach a file (fuzzy path picker)" },
  { keys: "click", action: "Expand tool / fold turn / select-to-copy" },
] as const;

/** Render the /keys notice body. */
export function formatKeysHelp(): string {
  const pad = Math.max(...ESSENTIAL_KEYS.map((k) => k.keys.length)) + 2;
  const lines = ["Keyboard", ""];
  for (const k of ESSENTIAL_KEYS) {
    lines.push(`  ${k.keys.padEnd(pad)}${k.action}`);
  }
  lines.push("");
  lines.push("Also: /details quiet|normal|verbose · /help for all slash commands.");
  lines.push("(/mouse is TUI-only — no-op in Electron.)");
  return lines.join("\n");
}
