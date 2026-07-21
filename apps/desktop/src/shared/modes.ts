import type { EngineCommand } from "./commands";

/**
 * The three interaction modes the user cycles with Shift+Tab. These are a
 * UI-level projection of the engine's two independent settings — the agent
 * `mode` (plan/execute) and the `approvalMode` (ask/auto):
 *
 *   plan     read-only; the model proposes a plan, runs no side-effecting tools
 *   execute  edits/commands allowed, each gated by an approval prompt
 *   yolo     execute with approvals off — tools run without prompting
 */
export type UiMode = "plan" | "execute" | "yolo";

export interface PendingModeTransition {
  sessionId: string;
  source: "plan";
  target: Exclude<UiMode, "plan">;
  planIdentity: string;
}

/** Collapse (engine mode, approval mode) into the user-facing 3-way mode. */
export function deriveUiMode(mode: string, approvals: string): UiMode {
  if (mode === "plan") return "plan";
  return approvals === "auto" ? "yolo" : "execute";
}

/** The next mode in the Shift+Tab cycle: plan → execute → yolo → plan. */
export function nextUiMode(cur: UiMode): UiMode {
  return cur === "plan" ? "execute" : cur === "execute" ? "yolo" : "plan";
}

/** The engine (mode, approvals) a UiMode projects to — the inverse of
 * `deriveUiMode`. Used to update the TUI's local mirrors OPTIMISTICALLY the moment
 * a Shift+Tab cycle is sent, so a fast double-press computes the next target from
 * the just-set value instead of the stale mirror the engine hasn't echoed yet
 * (which made the second press recompute the same target and stick a step). */
export function engineStateForUiMode(target: UiMode): {
  mode: "plan" | "execute";
  approvals: "ask" | "auto";
} {
  switch (target) {
    case "plan":
      return { mode: "plan", approvals: "ask" };
    case "execute":
      return { mode: "execute", approvals: "ask" };
    case "yolo":
      return { mode: "execute", approvals: "auto" };
  }
}

/** The engine commands that put the session into `target` (order matters:
 * set-mode always lands in gated `ask` engine-side, so yolo's `auto` must
 * follow it). All `set-approvals` here are quiet: this is the Shift+Tab cycle,
 * where the mode chip is the feedback — the transcript confirm is for typed
 * /approvals. */
export function commandsForUiMode(target: UiMode): EngineCommand[] {
  switch (target) {
    case "plan":
      return [
        { type: "set-mode", mode: "plan" },
        { type: "set-approvals", mode: "ask", quiet: true },
      ];
    case "execute":
      return [
        { type: "set-mode", mode: "execute" },
        { type: "set-approvals", mode: "ask", quiet: true },
      ];
    case "yolo":
      return [
        { type: "set-mode", mode: "execute" },
        { type: "set-approvals", mode: "auto", quiet: true },
      ];
  }
}

export type ModeAction = {
  target: UiMode;
  commands: EngineCommand[];
  requiresPlanDecision: boolean;
  /** Apply to local mirrors when non-null; null = keep current chip/state. */
  optimistic: { mode: "plan" | "execute"; approvals: "ask" | "auto"; uiMode: UiMode } | null;
};

/**
 * Direct mode selection (composer mode dropdown). When a plan card is waiting, bare
 * plan→execute/yolo is refused by the engine (no mode-changed, no approval).
 * In that case we only ping set-mode (so the engine can notice) and return
 * `optimistic: null` — the chip and approvals must NOT flip, or the chip lies
 * and a YOLO cycle would set approvalMode=auto while still planning (so the
 * next Enter would inherit unattended YOLO).
 */
export function selectModeAction(
  cur: UiMode,
  target: UiMode,
  opts: { planPending?: boolean } = {},
): ModeAction {
  if (cur === target) {
    return { target, commands: [], requiresPlanDecision: false, optimistic: null };
  }
  if (opts.planPending && cur === "plan" && target !== "plan") {
    return {
      target,
      commands: [],
      requiresPlanDecision: true,
      optimistic: null,
    };
  }
  const state = engineStateForUiMode(target);
  return {
    target,
    commands: commandsForUiMode(target),
    requiresPlanDecision: false,
    optimistic: { mode: state.mode, approvals: state.approvals, uiMode: target },
  };
}

/** Shift+Tab cycle action — advances to {@link nextUiMode}. */
export function cycleModeAction(
  cur: UiMode,
  opts: { planPending?: boolean } = {},
): ModeAction {
  const target = nextUiMode(cur);
  if (opts.planPending && cur === "plan" && target !== "plan") {
    return {
      target,
      commands: [],
      requiresPlanDecision: true,
      optimistic: null,
    };
  }
  const state = engineStateForUiMode(target);
  return {
    target,
    commands: commandsForUiMode(target),
    requiresPlanDecision: false,
    optimistic: { mode: state.mode, approvals: state.approvals, uiMode: target },
  };
}

export function commandsForPlanExitWithoutRunning(target: Exclude<UiMode, "plan">): EngineCommand[] {
  return [
    { type: "resolve-plan", decision: "keep-planning" },
    { type: "set-mode", mode: "execute" },
    { type: "set-approvals", mode: target === "yolo" ? "auto" : "ask", quiet: true },
  ];
}

/**
 * The mode color — shown on the input's mode chip (the `AGENT`/`PLAN`/`YOLO`
 * title), and the only mode-driven hue in the UI. Fixed (not theme-derived) so
 * the mode reads identically everywhere: execute's chip **follows the brand
 * accent in the app** (see `accent()` in app.tsx); PLAN green and YOLO red stay
 * fixed alert hues. `MODE_COLORS.execute` is the fallback blue when no brand
 * override is applied.
 */
export const MODE_COLORS: Record<UiMode, string> = {
  execute: "#70cbf4", // AGENT fallback — Blue 300
  plan: "#9ece6a", // PLAN — green
  yolo: "#f7768e", // YOLO — red
};

export function modeColor(m: UiMode): string {
  return MODE_COLORS[m];
}

/**
 * User-facing mode chip label. Execute reads **AGENT** (permission-gated coding
 * agent) — not "ASK", which collides with read-only Q&A modes in other tools
 * and reads as "ask the model" rather than "tools ask before running."
 */
export function modeWord(m: UiMode): string {
  if (m === "execute") return "AGENT";
  return m.toUpperCase();
}
