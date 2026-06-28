import type { EngineCommand } from "@vibe/shared";
import type { Palette } from "./themes.ts";

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

/** The signature dark purple for execute mode (distinct from plan's hue). */
export const EXECUTE_PURPLE = "#8b5cf6";

/** Mode accent color: plan = calm cyan, execute = core purple, yolo = danger. */
export function modeColor(m: UiMode, p: Palette): string {
  return m === "plan" ? p.tool : m === "yolo" ? p.del : EXECUTE_PURPLE;
}
