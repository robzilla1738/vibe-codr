/**
 * Pure chrome re-seed helpers used when the engine worker finishes bootstrap
 * after the TUI already mounted on PLACEHOLDER snapshot fields (BUG-107).
 * Kept out of app.tsx so the shipped path is unit-testable without OpenTUI.
 */
import type { EngineSnapshot, Mode } from "@vibe/shared";

export interface SessionStartEvent {
  type: "session-start";
  sessionId: string;
  model: string;
  mode: Mode;
}

export interface ChromeSeed {
  model: string;
  mode: Mode;
  approvalMode: EngineSnapshot["approvalMode"];
  goal: string | null;
  theme: string;
  accentColor: string;
  details: EngineSnapshot["details"];
  mouse: boolean;
}

/** Merge a session-start event + current engine snapshot into chrome identity. */
export function seedChromeFromSessionStart(
  event: Pick<SessionStartEvent, "model" | "mode">,
  snap: Partial<EngineSnapshot> | null | undefined,
): ChromeSeed {
  const s = snap ?? {};
  return {
    model: s.model || event.model,
    mode: s.mode ?? event.mode,
    approvalMode: s.approvalMode ?? "ask",
    goal: s.goal !== undefined ? s.goal : null,
    theme: s.theme || "default",
    accentColor: s.accentColor ?? "",
    details: s.details ?? "normal",
    mouse: typeof s.mouse === "boolean" ? s.mouse : true,
  };
}
