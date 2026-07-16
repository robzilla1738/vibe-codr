/** Renderer/main contract for the project-session interactive terminal. */
export type TerminalEvent =
  | { type: "data"; id: string; data: string; sequence: number }
  | { type: "exit"; id: string; exitCode: number; signal: number };

export type TerminalOpenRequest = {
  cwd: string;
  cols: number;
  rows: number;
};

export type TerminalOpenResult =
  | {
      ok: true;
      id: string;
      cwd: string;
      shell: string;
      reused: boolean;
      replay: string;
      sequence: number;
    }
  | { ok: false; error: string };

export type TerminalCommandResult = { ok: true } | { ok: false; error: string };

/** A stale renderer id can occur after a PTY exits between input/resize and its
 * exit event. Reopen that cwd instead of leaving the terminal permanently dead. */
export function terminalSessionNeedsReopen(error: string): boolean {
  return error === "Terminal session is no longer open"
    || error === "Terminal session exited before input could be written"
    || error === "Terminal session exited before it could be resized";
}
