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

/** The engine commands that put the session into `target` (order matters). */
export function commandsForUiMode(target: UiMode): EngineCommand[] {
  switch (target) {
    case "plan":
      // Reset approvals to ask so leaving plan later lands in execute, not yolo.
      return [
        { type: "set-mode", mode: "plan" },
        { type: "set-approvals", mode: "ask" },
      ];
    case "execute":
      return [
        { type: "set-mode", mode: "execute" },
        { type: "set-approvals", mode: "ask" },
      ];
    case "yolo":
      return [
        { type: "set-mode", mode: "execute" },
        { type: "set-approvals", mode: "auto" },
      ];
  }
}

/** Short label with a leading glyph, e.g. for the header pill and input title. */
export function modeLabel(m: UiMode): string {
  return m === "plan" ? "◑ PLAN" : m === "execute" ? "▶ EXECUTE" : "⚡ YOLO";
}

/**
 * The mode color — shown on the input's mode chip (the `ASK`/`PLAN`/`YOLO` title
 * on its top border), and the only mode-driven hue in the UI. Fixed (not
 * theme-derived) so the mode reads identically everywhere: ASK (execute, every
 * action gated by a prompt) = blue, PLAN (read-only) = green, YOLO (no prompts) =
 * red. Tokyo-night family, so it sits cleanly on the neutral chrome.
 */
export const MODE_COLORS: Record<UiMode, string> = {
  execute: "#7aa2f7", // ASK — blue
  plan: "#9ece6a", // PLAN — green
  yolo: "#f7768e", // YOLO — red
};

export function modeColor(m: UiMode): string {
  return MODE_COLORS[m];
}
