import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as pty from "node-pty";
import { isAllowedTerminalCwd } from "../shared/cwd-allowlist";
import type {
  TerminalCommandResult,
  TerminalEvent,
  TerminalOpenRequest,
  TerminalOpenResult,
} from "../shared/terminal";
import { enrichedEnv } from "./host-resolver";

const MIN_COLS = 16;
const MAX_COLS = 400;
const MIN_ROWS = 4;
const MAX_ROWS = 240;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_REPLAY_CHARS = 2 * 1024 * 1024;

type TerminalSession = {
  id: string;
  cwd: string;
  shell: string;
  pty: pty.IPty;
  replay: string;
  sequence: number;
};

/** Owns persistent project terminals for the lifetime of the Electron app. */
export class TerminalManager {
  private readonly byId = new Map<string, TerminalSession>();
  private readonly byCwd = new Map<string, TerminalSession>();

  constructor(private readonly emit: (event: TerminalEvent) => void) {}

  open(request: TerminalOpenRequest): TerminalOpenResult {
    if (!request || typeof request.cwd !== "string" || !isAllowedTerminalCwd(request.cwd)) {
      return { ok: false, error: "Terminal is limited to the active project or home directory" };
    }
    const cwd = resolve(request.cwd);
    if (!this.isDirectory(cwd)) {
      return { ok: false, error: "Project directory is no longer available" };
    }

    const existing = this.byCwd.get(cwd);
    if (existing) {
      try {
        existing.pty.resize(
          clampDimension(request.cols, MIN_COLS, MAX_COLS),
          clampDimension(request.rows, MIN_ROWS, MAX_ROWS),
        );
        return {
          ok: true,
          id: existing.id,
          cwd,
          shell: existing.shell,
          reused: true,
          replay: existing.replay,
          sequence: existing.sequence,
        };
      } catch {
        // A PTY may exit just before node-pty delivers onExit. Forget that
        // stale handle and replace it with a fresh shell below.
        this.forget(existing);
        try {
          existing.pty.kill();
        } catch {
          /* Already exited. */
        }
      }
    }

    const shell = this.shellPath();
    const id = randomUUID();
    let sessionPty: pty.IPty;
    try {
      sessionPty = pty.spawn(shell, this.shellArgs(), {
        name: "xterm-256color",
        cols: clampDimension(request.cols, MIN_COLS, MAX_COLS),
        rows: clampDimension(request.rows, MIN_ROWS, MAX_ROWS),
        cwd,
        env: {
          ...enrichedEnv({ homedir, env: process.env }),
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          TERM_PROGRAM: "Vibe Codr",
        },
        encoding: "utf8",
      });
    } catch (error) {
      return {
        ok: false,
        error: `Could not start ${shell}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const session: TerminalSession = {
      id,
      cwd,
      shell,
      pty: sessionPty,
      replay: "",
      sequence: 0,
    };
    this.byId.set(id, session);
    this.byCwd.set(cwd, session);

    sessionPty.onData((data) => {
      if (this.byId.get(id) !== session) return;
      session.sequence += 1;
      session.replay = appendReplay(session.replay, data);
      this.emit({ type: "data", id, data, sequence: session.sequence });
    });
    sessionPty.onExit(({ exitCode, signal }) => {
      if (this.byId.get(id) !== session) return;
      this.forget(session);
      this.emit({ type: "exit", id, exitCode, signal: signal ?? 0 });
    });

    return {
      ok: true,
      id,
      cwd,
      shell,
      reused: false,
      replay: "",
      sequence: 0,
    };
  }

  write(id: string, data: string): TerminalCommandResult {
    const session = this.match(id);
    if (!session) return { ok: false, error: "Terminal session is no longer open" };
    if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_WRITE_BYTES) {
      return { ok: false, error: "Terminal input is too large" };
    }
    try {
      session.pty.write(data);
      return { ok: true };
    } catch {
      this.forget(session);
      try {
        session.pty.kill();
      } catch {
        /* Already exited. */
      }
      return { ok: false, error: "Terminal session exited before input could be written" };
    }
  }

  resize(id: string, cols: number, rows: number): TerminalCommandResult {
    const session = this.match(id);
    if (!session) return { ok: false, error: "Terminal session is no longer open" };
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      return { ok: false, error: "Invalid terminal size" };
    }
    try {
      session.pty.resize(
        clampDimension(Math.trunc(cols), MIN_COLS, MAX_COLS),
        clampDimension(Math.trunc(rows), MIN_ROWS, MAX_ROWS),
      );
      return { ok: true };
    } catch {
      this.forget(session);
      try {
        session.pty.kill();
      } catch {
        /* Already exited. */
      }
      return { ok: false, error: "Terminal session exited before it could be resized" };
    }
  }

  dispose(): void {
    const sessions = [...this.byId.values()];
    this.byId.clear();
    this.byCwd.clear();
    for (const session of sessions) {
      try {
        session.pty.kill();
      } catch {
        /* Ignore shutdown races. */
      }
    }
  }

  private match(id: string): TerminalSession | null {
    return typeof id === "string" ? this.byId.get(id) ?? null : null;
  }

  private forget(session: TerminalSession): void {
    this.byId.delete(session.id);
    if (this.byCwd.get(session.cwd)?.id === session.id) {
      this.byCwd.delete(session.cwd);
    }
  }

  private isDirectory(cwd: string): boolean {
    try {
      return existsSync(cwd) && statSync(cwd).isDirectory();
    } catch {
      return false;
    }
  }

  private shellPath(): string {
    if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
    return process.env.SHELL || "/bin/zsh";
  }

  private shellArgs(): string[] {
    // Be explicit: GUI-launched shells do not consistently infer interactive
    // mode from a newly-created PTY during startup (notably fish).
    return process.platform === "win32" ? [] : ["-i", "-l"];
  }
}

function appendReplay(current: string, data: string): string {
  const next = current + data;
  if (next.length <= MAX_REPLAY_CHARS) return next;
  const start = next.length - MAX_REPLAY_CHARS;
  const lineBoundary = next.indexOf("\n", start);
  const retained = next.slice(lineBoundary >= 0 ? lineBoundary + 1 : start);
  // Reset parser/screen state before a truncated replay so an ANSI sequence
  // that began outside the retained window cannot corrupt the restored view.
  return `\x1bc${retained}`;
}

function clampDimension(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value) : min));
}
