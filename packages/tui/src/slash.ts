import type { EngineCommand } from "@vibe/shared";

/**
 * Map a typed line to an engine command. Slash lines that have a dedicated
 * command (mode/model/compact) map to it; every other `/name args` line
 * becomes a `run-slash`; plain text becomes a prompt submission. Shared by the
 * OpenTUI app and the readline REPL so both route input identically.
 */
/** Map a typed line to the ONE-or-MORE engine commands it expands to. Most lines
 * are a single command; `/plan <text>` / `/execute <text>` switch the mode AND
 * submit the text as the first turn (so the text isn't silently swallowed). */
export function lineToCommands(line: string): EngineCommand[] {
  const trimmed = line.trim();
  const m = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return [{ type: "submit-prompt", text: trimmed }];
  const name = m[1] ?? "";
  const args = (m[2] ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return [{ type: "submit-prompt", text: trimmed }];
  if ((name === "plan" || name === "execute") && args) {
    // Switch mode, then run the request in it — `/plan add oauth` plans "add
    // oauth" instead of dropping the description on the floor.
    return [{ type: "set-mode", mode: name }, { type: "submit-prompt", text: args }];
  }
  return [lineToCommand(line)];
}

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
      // Route a valid ask|auto straight to the immediate command (NOT quiet — a
      // typed switch deserves its one-line confirm, unlike the Shift+Tab cycle);
      // bare/unknown args fall through to the slash handler, which prints
      // current state/usage.
      return args === "ask" || args === "auto"
        ? { type: "set-approvals", mode: args }
        : { type: "run-slash", name, args };
    case "model":
      // Always route through the engine's /model router so subcommands
      // (`sub …`, `key …`) and persistence are handled in one place.
      return { type: "run-slash", name, args };
    case "compact":
      return { type: "compact" };
    default:
      return { type: "run-slash", name, args };
  }
}

/**
 * Map a typed answer to a permission decision. Shared by both UIs.
 *
 * Only EXACT tokens grant: the old first-letter parse turned "actually, wait…"
 * into a silent ALWAYS-allow and "sure" into a deny — an innocent sentence
 * could escalate a permission. Everything that isn't an exact yes/always/no is
 * a DENY carrying the text as feedback, which the engine folds into the deny
 * reason the model reads ("denied by user — use staging instead") — so typing
 * why steers the next attempt instead of being thrown away.
 */
export function parsePermissionDecision(input: string): {
  decision: "once" | "always" | "always-project" | "deny";
  feedback?: string;
} {
  const t = input.trim().toLowerCase();
  if (t === "y" || t === "yes" || t === "allow" || t === "once") return { decision: "once" };
  if (t === "a" || t === "always") return { decision: "always" };
  // `p`/`project` persists the grant into the project config (interactive-only).
  if (t === "p" || t === "project") return { decision: "always-project" };
  if (!t || t === "n" || t === "no" || t === "deny") return { decision: "deny" };
  return { decision: "deny", feedback: input.trim() };
}

/**
 * Route a submitted line while a permission card is pending. A slash line is NOT
 * a permission answer — it's a command the user wants to run (e.g. `/clear` to
 * escape a stuck card, `/theme`, or a value-menu selection). Without this, every
 * slash line became a DENY carrying the command as feedback, and `/clear` could
 * never rescue a pending card. A non-slash line still answers the card via
 * `parsePermissionDecision` (free text = deny-with-feedback). Mirrors the plan
 * card's own slash exemption.
 */
export function routePendingPermLine(
  input: string,
):
  | { kind: "passthrough" }
  | { kind: "perm"; decision: "once" | "always" | "always-project" | "deny"; feedback?: string } {
  if (input.trim().startsWith("/")) return { kind: "passthrough" };
  return { kind: "perm", ...parsePermissionDecision(input) };
}
