import type { EngineCommand } from "@vibe/shared";

/**
 * Map a typed line to an engine command. Slash lines that have a dedicated
 * command (mode/model/goal/compact) map to it; every other `/name args` line
 * becomes a `run-slash`; plain text becomes a prompt submission. Shared by the
 * OpenTUI app and the readline REPL so both route input identically.
 */
export function lineToCommand(line: string): EngineCommand {
  const trimmed = line.trim();
  // Command name is everything up to the first space, matching the engine's
  // `parseSlash` (so hyphenated custom commands like `/run-tests` route too).
  const m = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return { type: "submit-prompt", text: trimmed };

  const name = m[1] ?? "";
  const args = (m[2] ?? "").trim();
  switch (name) {
    case "plan":
      return { type: "set-mode", mode: "plan" };
    case "execute":
      return { type: "set-mode", mode: "execute" };
    case "model":
      return args
        ? { type: "set-model", model: args }
        : { type: "run-slash", name, args };
    case "goal":
      return { type: "set-goal", goal: args || null };
    case "compact":
      return { type: "compact" };
    default:
      return { type: "run-slash", name, args };
  }
}
