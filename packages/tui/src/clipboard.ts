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

/** Spawn `cmd` and pipe `text` to its stdin. Returns false if it can't launch or complete. */
export type ClipboardWriter = (cmd: string[], text: string) => boolean | Promise<boolean>;

export const bunWrite: ClipboardWriter = async (cmd, text) => {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    const stdin = proc.stdin;
    if (!stdin || typeof stdin === "number") return false;
    // Flush the write BEFORE end(): a large selection can return a pending write
    // under backpressure, and end()ing immediately would truncate it. Reap the
    // child too (`proc.exited`) so a long session doesn't leak one zombie per copy.
    await Promise.resolve(stdin.write(text));
    await Promise.resolve(stdin.end());
    return (await proc.exited) === 0;
  } catch {
    proc?.kill();
    return false; // binary not found / spawn failed — try the next candidate
  }
};

/**
 * Copy `text` to the clipboard. Emits OSC52 (via the injected `osc52`, e.g. the
 * renderer's `copyToClipboardOSC52`) AND writes to the first platform command that
 * launches. Returns whether any path reported success.
 */
export async function copyToClipboard(
  text: string,
  opts: { osc52?: (t: string) => boolean; write?: ClipboardWriter; platform?: string } = {},
): Promise<boolean> {
  if (!text) return false;
  let ok = false;
  try {
    if (opts.osc52?.(text)) ok = true;
  } catch {
    // OSC52 unsupported by the terminal — the platform command below still works.
  }
  const write = opts.write ?? bunWrite;
  for (const cmd of clipboardCommands(opts.platform ?? process.platform)) {
    if (await write(cmd, text)) return true;
  }
  return ok;
}
