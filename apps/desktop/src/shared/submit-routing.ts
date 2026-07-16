/**
 * Pure submit-line routing decisions extracted from App.tsx so god-module
 * keyboard/submit logic can be unit-tested without the full React tree.
 */

export type LocalSubmitRoute =
  | { kind: "jobs" }
  | { kind: "keys" }
  | { kind: "settings" }
  | { kind: "git" }
  | { kind: "engine" };

/** Classify a trimmed composer line for shell-local vs engine forwarding. */
export function classifySubmitLine(trimmed: string): LocalSubmitRoute {
  if (trimmed === "/jobs") return { kind: "jobs" };
  if (trimmed === "/keys") return { kind: "keys" };
  if (trimmed === "/settings" || trimmed === "/config") return { kind: "settings" };
  if (trimmed === "/git" || trimmed === "/branches") return { kind: "git" };
  return { kind: "engine" };
}
