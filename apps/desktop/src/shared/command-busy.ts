import type { EngineCommand } from "./commands";

/**
 * Whether the shell should optimistically set `busy` before the engine echoes
 * a `user-message` / turn. Pure commands (`run-slash` theme, model key, etc.)
 * often never emit `engine-idle`, so marking busy for every submit stuck the
 * Stop chrome and blocked project switches.
 *
 * Busy still *clears* only on `engine-idle` (or send failure / engine-error) —
 * this helper only controls the optimistic set.
 */
export function commandsExpectBusy(commands: readonly EngineCommand[]): boolean {
  for (const command of commands) {
    switch (command.type) {
      case "submit-prompt":
      case "compact":
      case "steer":
      case "resume-goal":
        return true;
      case "set-goal":
        if (command.goal != null && command.goal.trim() !== "") return true;
        break;
      case "resolve-plan":
        // Accept starts execution; edit re-plans (both are real engine work).
        if (command.decision === "accept" || command.decision === "edit") return true;
        break;
      default:
        break;
    }
  }
  return false;
}
