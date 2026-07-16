/**
 * Transcript density — how much tool/thinking detail the UI shows by default.
 *
 * Quiet/normal/verbose mirrors Claude Code's Normal/Verbose/Summary idea without
 * ever hiding that a tool ran (OpenCode `/details off` footgun). Presentation-only:
 * the engine always records full tool output; density only gates expand/collapse.
 */

export type TranscriptDensity = "quiet" | "normal" | "verbose";

export const DENSITY_LEVELS: readonly TranscriptDensity[] = ["quiet", "normal", "verbose"] as const;

export function isTranscriptDensity(v: string): v is TranscriptDensity {
  return (DENSITY_LEVELS as readonly string[]).includes(v);
}

/** Cycle quiet → normal → verbose → quiet (Ctrl+D / /details with no arg). */
export function nextDensity(cur: TranscriptDensity): TranscriptDensity {
  const i = DENSITY_LEVELS.indexOf(cur);
  return DENSITY_LEVELS[(i + 1) % DENSITY_LEVELS.length]!;
}

/** Human label for notices and the value menu. */
export function densityLabel(d: TranscriptDensity): string {
  switch (d) {
    case "quiet":
      return "quiet (tools collapsed, thinking hidden)";
    case "normal":
      return "normal (expand on click)";
    case "verbose":
      return "verbose (diffs, errors, thinking open)";
  }
}

/**
 * One-word density name for status chrome / chips (no parenthetical).
 * Prefer this when space is tight; {@link densityLabel} for menus/notices.
 */
export function densityShort(d: TranscriptDensity): string {
  return d;
}

/**
 * Effective collapse for a tool row under the active density.
 * Click toggles still mutate `block.collapsed`; density is an overlay:
 *  - quiet: always collapsed
 *  - verbose: force-open errors, diffs, and markdown (subagent) replies
 *  - normal: honor the block flag
 */
export function toolCollapsed(
  density: TranscriptDensity,
  block: { collapsed: boolean; isError: boolean; isDiff: boolean },
): boolean {
  if (density === "quiet") return true;
  if (density === "verbose" && (block.isError || block.isDiff)) return false;
  return block.collapsed;
}

/** Whether to render landed thinking rows at all. */
export function showThinkingRows(density: TranscriptDensity): boolean {
  return density !== "quiet";
}

/** Effective collapse for a thinking row. */
export function thinkingCollapsed(density: TranscriptDensity, collapsed: boolean): boolean {
  if (density === "verbose") return false;
  return collapsed;
}
