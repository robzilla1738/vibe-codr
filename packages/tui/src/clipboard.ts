/**
 * Best-effort clipboard copy for the TUI. Two paths, tried together so selection
 * copy works both locally and over SSH:
 *   1. OSC52 — a terminal escape the renderer emits; terminal-agnostic and works
 *      through SSH/tmux (when the terminal honors it).
 *   2. The platform clipboard command — `pbcopy` (macOS), `clip` (Windows), or
 *      `wl-copy`/`xclip`/`xsel` (Linux) — for local terminals that ignore OSC52.
 * Pure command selection is split out so it's unit-testable without spawning.
 */

/** The candidate clipboard commands to try, in order, for a platform. */
export function clipboardCommands(platform: string): string[][] {
  if (platform === "darwin") return [["pbcopy"]];
  if (platform === "win32") return [["clip"]];
  // Linux/BSD: Wayland first, then the two common X11 tools.
  return [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
}

/** Spawn `cmd` and pipe `text` to its stdin. Returns false if it can't launch. */
export type ClipboardWriter = (cmd: string[], text: string) => boolean;

const bunWrite: ClipboardWriter = (cmd, text) => {
  try {
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(text);
    void proc.stdin.end();
    return true;
  } catch {
    return false; // binary not found / spawn failed — try the next candidate
  }
};

/**
 * Copy `text` to the clipboard. Emits OSC52 (via the injected `osc52`, e.g. the
 * renderer's `copyToClipboardOSC52`) AND writes to the first platform command that
 * launches. Returns whether any path reported success.
 */
export function copyToClipboard(
  text: string,
  opts: { osc52?: (t: string) => boolean; write?: ClipboardWriter; platform?: string } = {},
): boolean {
  if (!text) return false;
  let ok = false;
  try {
    if (opts.osc52?.(text)) ok = true;
  } catch {
    // OSC52 unsupported by the terminal — the platform command below still works.
  }
  const write = opts.write ?? bunWrite;
  for (const cmd of clipboardCommands(opts.platform ?? process.platform)) {
    if (write(cmd, text)) return true;
  }
  return ok;
}
