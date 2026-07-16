/**
 * "Vibe Codr" in a chunky ░██ block face — the empty-state wordmark. Compact
 * (7 rows, 80 cols) so it fits the reading-width column and reads at a glance,
 * opencode-style. Rendered as one brand-coloured <text> per line, the block
 * left-aligned and centered as a whole by the flex spacers around it. Leading and
 * internal spaces are load-bearing (they ARE the glyph shapes) — do not reflow.
 */
export const WORDMARK: string[] = [
  "░██    ░██ ░██░██                        ░██████                    ░██",
  "░██    ░██    ░██                       ░██   ░██                   ░██",
  "░██    ░██ ░██░████████   ░███████     ░██         ░███████   ░████████ ░██░████",
  "░██    ░██ ░██░██    ░██ ░██    ░██    ░██        ░██    ░██ ░██    ░██ ░███",
  " ░██  ░██  ░██░██    ░██ ░█████████    ░██        ░██    ░██ ░██    ░██ ░██",
  "  ░██░██   ░██░███   ░██ ░██            ░██   ░██ ░██    ░██ ░██   ░███ ░██",
  "   ░███    ░██░██░█████   ░███████       ░██████   ░███████   ░█████░██ ░██",
];

/** Widest line of {@link WORDMARK} — the column width the splash needs to show it. */
export const WORDMARK_COLS = 80;
