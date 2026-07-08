import type { UIEvent } from "@vibe/shared";

export interface ParsedLoop {
  intervalMs: number;
  prompt: string;
  until?: string;
  max?: number;
  /** Non-fatal usage warnings (a mistyped flag/interval token kept as prompt
   * text) for the caller to surface — the loop still starts. */
  warnings?: string[];
}

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** A queued loop iteration was removed from the work queue before it ran
 * (abort / dequeue / queue clear). Distinguished from a real iteration failure
 * so the stop reason reads as a cancellation, not an error. */
export class LoopCancelledError extends Error {}

/** Parse a duration token like "30s", "5m", "2h" into milliseconds. Zero is
 * rejected ("0s" would re-tick back-to-back with no pacing — never intended). */
export function parseDuration(token: string): number | null {
  const m = token.match(/^(\d+)(s|m|h)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  const unit = m[2];
  return unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
}

/**
 * Parse `/loop` arguments:
 *   [interval] <prompt or /command> [--until <condition>] [--max <N>]
 * Returns null if no prompt is present.
 */
export function parseLoopArgs(args: string): ParsedLoop | null {
  let rest = args.trim();
  const warnings: string[] = [];

  let max: number | undefined;
  const maxMatch = rest.match(/--max\s+(\d+)/);
  if (maxMatch) {
    // `--max 0` is rejected (returns null → usage message) rather than being
    // silently dropped, which would turn "run at most zero times" into an
    // UNBOUNDED loop.
    max = Number(maxMatch[1]);
    if (max < 1) return null;
    rest = rest.replace(maxMatch[0], "").trim();
  }

  // BUG-076: only accept a TRAILING `--until` with a single token or a quoted
  // value. `/--until\s+(.+)$/` stole prose like "explain how --until loops work".
  let until: string | undefined;
  const untilQuoted =
    rest.match(/\s--until\s+"([^"]+)"\s*$/) ?? rest.match(/\s--until\s+'([^']+)'\s*$/);
  const untilBare = untilQuoted ? null : rest.match(/\s--until\s+(\S+)\s*$/);
  const untilLeadQuoted =
    rest.match(/^--until\s+"([^"]+)"\s+/) ?? rest.match(/^--until\s+'([^']+)'\s+/);
  const untilLeadBare = untilLeadQuoted ? null : rest.match(/^--until\s+(\S+)(?:\s+|$)/);
  if (untilQuoted) {
    until = untilQuoted[1]!.trim();
    rest = rest.slice(0, untilQuoted.index).trim();
  } else if (untilBare) {
    until = untilBare[1]!.trim();
    rest = rest.slice(0, untilBare.index).trim();
  } else if (untilLeadQuoted) {
    until = untilLeadQuoted[1]!.trim();
    rest = rest.slice(untilLeadQuoted[0].length).trim();
  } else if (untilLeadBare) {
    until = untilLeadBare[1]!.trim();
    rest = rest.slice(untilLeadBare[0].length).trim();
  }

  // Optional leading interval token.
  let intervalMs = DEFAULT_INTERVAL_MS;
  const firstSpace = rest.indexOf(" ");
  const firstToken = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  const parsedInterval = parseDuration(firstToken);
  if (parsedInterval !== null) {
    intervalMs = parsedInterval;
    rest = firstSpace === -1 ? "" : rest.slice(firstSpace + 1).trim();
  } else if (/^\d+[a-z]+$/i.test(firstToken)) {
    // Digits+unit in the interval position ("5x", "30sec", "0s") that isn't a
    // valid duration is almost certainly a mistyped interval — say so instead
    // of silently pacing at the default. Warn rather than reject: a prompt
    // genuinely starting with such a token still runs (it stays prompt text).
    warnings.push(
      `"${firstToken}" looks like an interval but isn't one (use Ns/Nm/Nh with N > 0, e.g. 30s, 5m, 2h) — ` +
        "it was kept as prompt text and the loop uses the default 10m interval.",
    );
  }

  if (!rest) return null;

  // BUG-077: warn only for failed flag applications, not prose that mentions
  // `--watch` etc. Detect a bare trailing `--until`/`--max`, or `--max <non-int>`.
  if (/\s--(?:max|until)\s*$/i.test(rest) || /^--(?:max|until)\s*$/i.test(rest)) {
    const token = rest.match(/--(max|until)\s*$/i)?.[0] ?? "--until";
    warnings.push(
      `"${token}" was not applied (missing or invalid value) and was kept as prompt text — ` +
        "usage: --until <condition>, --max <N>.",
    );
  } else if (/\s--max\s+\S+/i.test(rest) && max === undefined) {
    // e.g. `--max ten` — present but not applied as a number.
    warnings.push(
      `"--max" was not applied (missing or invalid value) and was kept as prompt text — ` +
        "usage: --until <condition>, --max <N>.",
    );
  }

  return {
    intervalMs,
    prompt: rest,
    ...(until ? { until } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export interface LoopOptions extends ParsedLoop {
  id: string;
  /** Run one iteration and return the result text. */
  run: (prompt: string) => Promise<string>;
  /** Evaluate whether `until` has been satisfied by `result`. */
  evaluate?: (
    result: string,
    condition: string,
  ) => Promise<{ done: boolean; reason: string }>;
  /** Called when the loop is stopped — lets the host abort an in-flight turn. */
  onStop?: () => void;
  emit: (event: UIEvent) => void;
}

/**
 * Runs a prompt on a recurring interval until a stop condition is met, a max
 * iteration count is reached, or it is explicitly stopped.
 */
export class LoopController {
  #opts: LoopOptions;
  #stopped = false;
  #iteration = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive `--until` evaluation failures — a persistently failing check
   * (bad model id, dead key) would otherwise silently make the condition inert
   * and, with no `--max`, loop forever. Warned on the 1st and every 5th. */
  #evalFailStreak = 0;
  #resolveDone!: () => void;
  #done: Promise<void>;

  constructor(opts: LoopOptions) {
    this.#opts = opts;
    this.#done = new Promise((resolve) => {
      this.#resolveDone = resolve;
    });
  }

  /** Begin the loop (first iteration runs immediately). */
  start(): void {
    void this.#tick();
  }

  /** Resolves when the loop has stopped. */
  whenDone(): Promise<void> {
    return this.#done;
  }

  stop(reason = "stopped by user"): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    // Cancel an iteration that's mid-flight (otherwise the model turn — and its
    // side-effecting tools — would keep running after the user stopped the loop).
    this.#opts.onStop?.();
    this.#opts.emit({ type: "loop-stopped", loopId: this.#opts.id, reason });
    this.#resolveDone();
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    this.#iteration += 1;
    this.#opts.emit({
      type: "loop-tick",
      loopId: this.#opts.id,
      iteration: this.#iteration,
    });

    let result = "";
    try {
      result = await this.#opts.run(this.#opts.prompt);
    } catch (err) {
      this.stop(
        err instanceof LoopCancelledError
          ? `iteration cancelled (${err.message})`
          : `iteration failed: ${(err as Error).message}`,
      );
      return;
    }
    if (this.#stopped) return;

    if (this.#opts.until && this.#opts.evaluate) {
      try {
        const verdict = await this.#opts.evaluate(result, this.#opts.until);
        this.#evalFailStreak = 0;
        if (verdict.done) {
          this.stop(`condition met: ${verdict.reason}`);
          return;
        }
      } catch {
        // Treat evaluation failure as "not yet" and keep looping — but a
        // PERSISTENTLY failing check (model unreachable / bad id) silently turns
        // `--until` into "never", so surface it instead of looping mutely.
        this.#evalFailStreak += 1;
        if (this.#evalFailStreak === 1 || this.#evalFailStreak % 5 === 0) {
          this.#opts.emit({
            type: "notice",
            level: "warn",
            message:
              `Loop --until check failed ${this.#evalFailStreak}× (model unreachable or the ` +
              "condition can't be evaluated); the loop continues. /loop stop to cancel.",
          });
        }
      }
    }

    if (this.#opts.max && this.#iteration >= this.#opts.max) {
      this.stop(`reached max iterations (${this.#opts.max})`);
      return;
    }

    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.#tick(), this.#opts.intervalMs);
  }
}
