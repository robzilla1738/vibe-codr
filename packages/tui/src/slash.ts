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
  // A slash line is only a command when the token after "/" is a plausible
  // command NAME (letters/digits/`_`/`-`, no embedded "/" or "."). Otherwise it's
  // ordinary user text that merely starts with a slash — a path (`/etc/hosts is
  // world-readable`), a comment (`// TODO …`), an endpoint (`/api/users returns
  // 500`) — and must be SENT to the model, not swallowed as an unknown command
  // (the engine would print "Unknown command" and lose the whole message).
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return { type: "submit-prompt", text: trimmed };
  switch (name) {
    case "plan":
      return { type: "set-mode", mode: "plan" };
    case "execute":
      return { type: "set-mode", mode: "execute" };
    case "approvals":
      // Route a valid ask|auto straight to the immediate command; bare/unknown
      // args fall through to the slash handler, which prints current state/usage.
      return args === "ask" || args === "auto"
        ? { type: "set-approvals", mode: args }
        : { type: "run-slash", name, args };
    case "model":
      // Always route through the engine's /model router so subcommands
      // (`sub …`, `key …`) and persistence are handled in one place.
      return { type: "run-slash", name, args };
    case "goal":
      return { type: "set-goal", goal: args || null };
    case "compact":
      return { type: "compact" };
    default:
      return { type: "run-slash", name, args };
  }
}

/** Map a typed answer to a permission decision (default deny). Shared by both UIs. */
export function parsePermissionDecision(
  input: string,
): "once" | "always" | "deny" {
  const c = input.trim().toLowerCase()[0];
  return c === "y" ? "once" : c === "a" ? "always" : "deny";
}
