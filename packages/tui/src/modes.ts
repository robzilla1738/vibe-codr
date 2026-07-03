import type { EngineCommand } from "@vibe/shared";

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

/** Collapse (engine mode, approval mode) into the user-facing 3-way mode. */
export function deriveUiMode(mode: string, approvals: string): UiMode {
  if (mode === "plan") return "plan";
  return approvals === "auto" ? "yolo" : "execute";
}

/** The next mode in the Shift+Tab cycle: plan → execute → yolo → plan. */
export function nextUiMode(cur: UiMode): UiMode {
  return cur === "plan" ? "execute" : cur === "execute" ? "yolo" : "plan";
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

/**
 * The mode color — shown on the input's mode chip (the `ASK`/`PLAN`/`YOLO` title
 * on its top border), and the only mode-driven hue in the UI. Fixed (not
 * theme-derived) so the mode reads identically everywhere: ASK (execute, every
 * action gated by a prompt) = Blue 300, PLAN (read-only) = green, YOLO (no
 * prompts) = red. Sits cleanly on the neutral chrome.
 */
export const MODE_COLORS: Record<UiMode, string> = {
  execute: "#70cbf4", // ASK — Blue 300
  plan: "#9ece6a", // PLAN — green
  yolo: "#f7768e", // YOLO — red
};

export function modeColor(m: UiMode): string {
  return MODE_COLORS[m];
}
