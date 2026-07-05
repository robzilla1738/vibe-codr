import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vibeConfigDir } from "./memory.ts";
import type { DoctorCheck } from "./introspect.ts";

/**
 * Last-resort crash visibility. `installCrashHandlers` binds ONLY
 * `uncaughtException` + `unhandledRejection` (SIGINT stays owned by the TUI's
 * graceful-exit path). On a fatal error the handler, in order and each step
 * individually try/caught so a failure in one still runs the rest:
 *   (a) restores the terminal with raw ANSI writes (core can't import @vibe/tui),
 *   (b) writes a REDACTED crash log to ~/.config/vibe-codr/crashes/<iso>.log,
 *   (c) prints the absolute log path to stderr,
 *   (d) exits 1.
 */

/** Crash-log directory, beside the rest of the user-global vibe-codr state. */
export function crashesDir(): string {
  return join(vibeConfigDir(), "crashes");
}

// Keys whose VALUE is a secret regardless of content, and inline patterns that
// catch a secret embedded in a free string (e.g. an argv entry `--api-key=sk-1`
// or `Authorization: Bearer abc`). Mirrors the key-based masking in introspect.ts.
const SECRET_KEY_RE = /api[-_]?key|token|authorization|secret/i;
const SECRET_INLINE_RE =
  /((?:api[-_]?key|token|authorization|secret)["'\s]*[:=]["'\s]*)([^\s"',]+)/gi;
const BEARER_RE = /(bearer\s+)(\S+)/gi;
// Bare vendor-prefixed secret tokens: a key can ride in a stack frame or an argv
// entry with NO adjacent keyword to trip the rules above (an unlabeled `sk-…`,
// `ghp_…`, Slack `xoxb-…`, or Google `AIza…`). Anchored on a well-known prefix
// plus a substantial body so ordinary hyphenated words and short hashes survive.
const SECRET_TOKEN_RE = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abpr])[_-][A-Za-z0-9][A-Za-z0-9_-]{9,}\b/g;
const GOOGLE_KEY_RE = /\bAIza[0-9A-Za-z_-]{20,}\b/g;

/** Deep-clone a value, masking secret-bearing keys and inline secret strings. */
export function redactCrash(value: unknown): unknown {
  if (typeof value === "string") {
    // Mask `Bearer <token>` FIRST (its token can contain no delimiter but the
    // inline rule below stops at whitespace), then key=value secrets, then any
    // remaining bare key-shaped token (prefix-anchored) that had no keyword.
    return value
      .replace(BEARER_RE, "$1***")
      .replace(SECRET_INLINE_RE, "$1***")
      .replace(SECRET_TOKEN_RE, "***")
      .replace(GOOGLE_KEY_RE, "***");
  }
  if (Array.isArray(value)) return value.map(redactCrash);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? "***" : redactCrash(v);
    }
    return out;
  }
  return value;
}

export interface CrashRecord {
  version: string;
  ts: string;
  kind: string;
  message: string;
  stack: string;
  argv: string[];
  platform: string;
}

export function buildCrashRecord(
  kind: string,
  err: unknown,
  opts: { version: string; now: Date; argv: string[] },
): CrashRecord {
  const e = err as { message?: unknown; stack?: unknown };
  return {
    version: opts.version,
    ts: opts.now.toISOString(),
    kind,
    message: typeof e?.message === "string" ? e.message : String(err),
    stack: typeof e?.stack === "string" ? e.stack : "",
    argv: opts.argv,
    platform: `${process.platform}-${process.arch}`,
  };
}

/** Write a redacted crash record; returns the absolute path. Uses sync IO — the
 * process is about to exit, so a synchronous write is the reliable choice. */
export function writeCrashLog(record: CrashRecord, dir: string = crashesDir()): string {
  mkdirSync(dir, { recursive: true });
  // ISO timestamps carry `:`/`.` which are invalid in filenames on some
  // platforms (Windows) — normalize to `-`.
  const path = join(dir, `${record.ts.replace(/[:.]/g, "-")}.log`);
  writeFileSync(path, JSON.stringify(redactCrash(record), null, 2));
  return path;
}

/** Restore the terminal from a raw/alt-screen state via literal ANSI (core can't
 * import the TUI). Best-effort — a failure here must not block the crash log. */
function restoreTerminal(write: (s: string) => void): void {
  try {
    // Exit alt-screen, show cursor, disable every mouse-tracking mode.
    write("\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l");
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (b: boolean) => void };
    if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
  } catch {
    // ignore — restoring the terminal is a courtesy, not a requirement
  }
}

export interface CrashHandlerDeps {
  version: string;
  dir?: string;
  now?: () => Date;
  argv?: string[];
  writeStdout?: (s: string) => void;
  writeStderr?: (s: string) => void;
  exit?: (code: number) => void;
}

/** The crash handler body — exported so tests can drive it without crashing the
 * test runner (inject `exit`/`writeStderr`/`dir`). */
export function handleCrash(kind: string, err: unknown, deps: CrashHandlerDeps): void {
  const writeOut =
    deps.writeStdout ??
    ((s: string) => {
      try {
        process.stdout.write(s);
      } catch {
        /* stdout may be closed */
      }
    });
  const writeErr =
    deps.writeStderr ??
    ((s: string) => {
      try {
        process.stderr.write(s);
      } catch {
        /* stderr may be closed */
      }
    });
  const exit = deps.exit ?? ((c: number) => process.exit(c));

  // (a) restore the terminal first so the user isn't stranded in raw/alt state.
  restoreTerminal(writeOut);

  // (b) write the redacted crash log.
  let path: string | null = null;
  try {
    const record = buildCrashRecord(kind, err, {
      version: deps.version,
      now: (deps.now ?? (() => new Date()))(),
      argv: deps.argv ?? process.argv,
    });
    path = writeCrashLog(record, deps.dir ?? crashesDir());
  } catch {
    // even if the log write fails, still restore + print + exit
  }

  // (c) tell the user what happened and where the log is.
  try {
    const message = (err as { message?: string })?.message ?? String(err);
    writeErr(`\nvibe-codr crashed (${kind}): ${message}\n`);
    if (path) writeErr(`Crash log: ${path}\n`);
  } catch {
    /* ignore */
  }

  // (d) exit non-zero.
  exit(1);
}

/** Restore the terminal on a fatal SIGNAL (SIGTERM/SIGHUP), then exit with the
 * conventional 128+signal code. NOT a crash: no log, no finalize (the engine is
 * unreachable from this static context) — just make sure `kill`/terminal-close
 * doesn't strand the user in raw/alt-screen. Exported so tests can drive it. */
export function handleFatalSignal(
  sig: "SIGTERM" | "SIGHUP",
  deps: { writeStdout?: (s: string) => void; exit?: (code: number) => void } = {},
): void {
  const writeOut =
    deps.writeStdout ??
    ((s: string) => {
      try {
        process.stdout.write(s);
      } catch {
        /* stdout may be closed */
      }
    });
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  restoreTerminal(writeOut);
  exit(sig === "SIGTERM" ? 143 : 129);
}

/** Bind the process-level fatal-error handlers. SIGINT is intentionally NOT
 * bound here — the TUI owns Ctrl+C (graceful finalize-then-exit). SIGTERM/SIGHUP
 * (kill, terminal close) ARE bound: without a handler the default action skips
 * OpenTUI's exit hook and leaves the terminal in raw/alt-screen. */
export function installCrashHandlers(deps: { version: string }): void {
  process.on("uncaughtException", (err) => handleCrash("uncaughtException", err, deps));
  process.on("unhandledRejection", (reason) => handleCrash("unhandledRejection", reason, deps));
  process.on("SIGTERM", () => handleFatalSignal("SIGTERM"));
  process.on("SIGHUP", () => handleFatalSignal("SIGHUP"));
}

/** Crash-log files (absolute paths) with an mtime within `withinDays`, oldest
 * first. Tolerates a missing dir (returns []). Sync so `/doctor` can call it. */
export function recentCrashes(
  withinDays = 7,
  dir: string = crashesDir(),
  nowMs: number = Date.now(),
): string[] {
  try {
    const cutoff = nowMs - withinDays * 24 * 60 * 60 * 1000;
    return readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => join(dir, f))
      .filter((p) => {
        try {
          return statSync(p).mtimeMs >= cutoff;
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** `/doctor` line for recent crashes. Clean → `ok:null` (○); any recent crash →
 * `ok:false` (✗) with the count + newest log path. Pure over the file list. */
export function crashDoctorCheck(crashFiles: string[]): DoctorCheck {
  if (crashFiles.length === 0) {
    return { label: "crashes", ok: null, detail: "no recent crashes" };
  }
  const newest = crashFiles[crashFiles.length - 1];
  return {
    label: "crashes",
    ok: false,
    detail: `${crashFiles.length} crash log(s) in the last 7 days — newest: ${newest}`,
  };
}
