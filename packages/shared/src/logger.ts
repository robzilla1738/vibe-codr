export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(scope: string): Logger;
}

/**
 * Minimal structured logger that writes to stderr (so it never corrupts the
 * TUI render on stdout). Level is controlled by `VIBE_LOG` (default `warn`).
 */
export function createLogger(scope = "vibe", level?: LogLevel): Logger {
  const threshold =
    level ?? (process.env.VIBE_LOG as LogLevel | undefined) ?? "warn";
  const min = LEVEL_ORDER[threshold] ?? LEVEL_ORDER.warn;

  const emit = (lvl: LogLevel, message: string, meta?: unknown) => {
    if (LEVEL_ORDER[lvl] < min) return;
    const line = `[${lvl}] ${scope}: ${message}`;
    if (meta !== undefined) {
      process.stderr.write(`${line} ${safeStringify(meta)}\n`);
    } else {
      process.stderr.write(`${line}\n`);
    }
  };

  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
    child: (childScope) => createLogger(`${scope}:${childScope}`, threshold),
  };
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
