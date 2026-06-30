/**
 * "VIBE CODR" in the FIGlet "impossible" font (a slash-drawn 3D isometric face) —
 * the empty-state wordmark used on wide terminals. Generated art; rendered as one
 * brand-coloured <text> per line, left-aligned as a block and centered as a whole.
 * Trailing whitespace is stripped (irrelevant to a left-aligned block); leading
 * and internal spaces are load-bearing (they ARE the glyph shapes) — do not touch.
 */
export const WORDMARK_3D: string[] = [
  " _          _        _          _               _                _             _            _            _",
  "/\\ \\    _ / /\\      /\\ \\       / /\\            /\\ \\            /\\ \\           /\\ \\         /\\ \\         /\\ \\",
  "\\ \\ \\  /_/ / /      \\ \\ \\     / /  \\          /  \\ \\          /  \\ \\         /  \\ \\       /  \\ \\____   /  \\ \\",
  " \\ \\ \\ \\___\\/       /\\ \\_\\   / / /\\ \\        / /\\ \\ \\        / /\\ \\ \\       / /\\ \\ \\     / /\\ \\_____\\ / /\\ \\ \\",
  " / / /  \\ \\ \\      / /\\/_/  / / /\\ \\ \\      / / /\\ \\_\\      / / /\\ \\ \\     / / /\\ \\ \\   / / /\\/___  // / /\\ \\_\\",
  " \\ \\ \\   \\_\\ \\    / / /    / / /\\ \\_\\ \\    / /_/_ \\/_/     / / /  \\ \\_\\   / / /  \\ \\_\\ / / /   / / // / /_/ / /",
  "  \\ \\ \\  / / /   / / /    / / /\\ \\ \\___\\  / /____/\\       / / /    \\/_/  / / /   / / // / /   / / // / /__\\/ /",
  "   \\ \\ \\/ / /   / / /    / / /  \\ \\ \\__/ / /\\____\\/      / / /          / / /   / / // / /   / / // / /_____/",
  "    \\ \\ \\/ /___/ / /__  / / /____\\_\\ \\  / / /______     / / /________  / / /___/ / / \\ \\ \\__/ / // / /\\ \\ \\",
  "     \\ \\  //\\__\\/_/___\\/ / /__________\\/ / /_______\\   / / /_________\\/ / /____\\/ /   \\ \\___\\/ // / /  \\ \\ \\",
  "      \\_\\/ \\/_________/\\/_____________/\\/__________/   \\/____________/\\/_________/     \\/_____/ \\/_/    \\_\\/",
];

/** Widest line of {@link WORDMARK_3D} — the column width the splash needs to show it. */
export const WORDMARK_3D_COLS = 111;
