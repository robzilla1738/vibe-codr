import type { UIEvent } from "@vibe/shared";

export interface ParsedLoop {
  intervalMs: number;
  prompt: string;
  condition?: LoopCondition;
  max?: number;
  /** True when the user opted into an unbounded loop (`--unlimited`). */
  unlimited?: boolean;
  /** True when `max` was filled from {@link DEFAULT_LOOP_MAX} (not user `--max`). */
  maxDefaulted?: boolean;
  /** Non-fatal usage warnings (a mistyped flag/interval token kept as prompt
   * text) for the caller to surface — the loop still starts. */
  warnings?: string[];
}

/** A model judgment preserves the original `--until` behavior; a command
 * condition is satisfied only by a sandboxed exit status of zero. */
export type LoopCondition = { kind: "model"; text: string } | { kind: "command"; command: string };

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** Safety default when `--max` / `--unlimited` is omitted. Prevents an
 * interval loop from running forever on a flaky `--until` or forgotten stop.
 * Explicit `--unlimited` (or a positive `--max`) overrides. */
export const DEFAULT_LOOP_MAX = 12;

/** Consecutive `--until` evaluation failures before the loop stops (instead of
 * treating a dead evaluator as "never done" forever). */
export const MAX_UNTIL_EVAL_FAILURES = 5;

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

export interface ParseLoopOpts {
  /**
   * Default max when `--max` / `--unlimited` omitted. From config.loop.defaultMax
   * (0 = unlimited default). Falls back to {@link DEFAULT_LOOP_MAX}.
   */
  defaultMax?: number;
}

interface ArgToken {
  start: number;
  end: number;
  value: string;
  fullyQuoted: boolean;
}

/** Shell-like option lexer. Quotes are only syntax for `/loop` parsing: the
 * prompt itself is retained from the original source slices. Inside quotes we
 * unescape only the active quote and backslash; every other backslash is kept
 * verbatim so regexes and shell expressions survive. */
function lexLoopArgs(input: string): ArgToken[] | null {
  const tokens: ArgToken[] = [];
  let i = 0;
  while (i < input.length) {
    while (/\s/u.test(input[i] ?? "")) i += 1;
    if (i >= input.length) break;
    const start = i;
    let value = "";
    let quote: '"' | "'" | undefined;
    let sawQuoted = false;
    let sawUnquoted = false;
    while (i < input.length) {
      const ch = input[i]!;
      if (quote) {
        if (ch === "\\") {
          const next = input[i + 1];
          if (next === quote || next === "\\") {
            value += next;
            i += 2;
            continue;
          }
          value += ch;
          i += 1;
          continue;
        }
        if (ch === quote) {
          quote = undefined;
          i += 1;
          continue;
        }
        value += ch;
        i += 1;
        continue;
      }
      if (/\s/u.test(ch)) break;
      if (ch === '"' || ch === "'") {
        quote = ch;
        sawQuoted = true;
        i += 1;
        continue;
      }
      sawUnquoted = true;
      if (ch === "\\" && i + 1 < input.length) {
        value += input[i + 1]!;
        i += 2;
      } else {
        value += ch;
        i += 1;
      }
    }
    if (quote) return null;
    tokens.push({ start, end: i, value, fullyQuoted: sawQuoted && !sawUnquoted });
  }
  return tokens;
}

function withoutRanges(input: string, ranges: Array<[number, number]>): string {
  const tokens = lexLoopArgs(input);
  if (!tokens) return input.trim();
  return tokens
    .filter((token) => !ranges.some(([start, end]) => token.start >= start && token.end <= end))
    .map((token) => input.slice(token.start, token.end))
    .join(" ")
    .trim();
}

/**
 * Parse `/loop` arguments:
 *   [interval] <prompt or /command> [--until <condition> | --until-cmd "<command>"]
 *     [--max <N>] [--unlimited]
 * Returns null if no prompt is present.
 *
 * When neither `--max` nor `--unlimited` is set, the configured default max
 * (or {@link DEFAULT_LOOP_MAX}) is applied so a forgotten bound can't burn
 * forever. `--max 0` is rejected (usage error) — use `--unlimited` for that.
 */
export function parseLoopArgs(args: string, opts: ParseLoopOpts = {}): ParsedLoop | null {
  let rest = args.trim();
  const warnings: string[] = [];
  const configuredDefault = opts.defaultMax !== undefined ? opts.defaultMax : DEFAULT_LOOP_MAX;

  const initialTokens = lexLoopArgs(rest);
  if (!initialTokens) return null;
  let tokens: ArgToken[] = initialTokens;

  let unlimited = false;
  const unlimitedTokens = tokens.filter((t) => !t.fullyQuoted && t.value === "--unlimited");
  if (unlimitedTokens.length) {
    unlimited = true;
    rest = withoutRanges(
      rest,
      unlimitedTokens.map((t) => [t.start, t.end]),
    );
    tokens = lexLoopArgs(rest)!;
  }

  let max: number | undefined;
  const validMax = tokens
    .map((token, index) => ({ token, value: tokens[index + 1] }))
    .filter(
      ({ token, value }) =>
        !token.fullyQuoted &&
        token.value === "--max" &&
        value !== undefined &&
        !value.fullyQuoted &&
        /^\d+$/u.test(value.value),
    );
  if (validMax.length > 1) return null;
  if (validMax[0]) {
    // `--max 0` is rejected (returns null → usage message) rather than being
    // silently dropped, which would turn "run at most zero times" into an
    // UNBOUNDED loop. Use `--unlimited` for intentional forever.
    max = Number(validMax[0].value!.value);
    if (max < 1) return null;
    rest = withoutRanges(rest, [[validMax[0].token.start, validMax[0].value!.end]]);
    tokens = lexLoopArgs(rest)!;
  }

  // BUG-076: a condition is only recognized at the leading/trailing boundary
  // (after bound flags are removed), so prose like "explain --until loops" is
  // still a prompt. Duplicate or mixed condition flags are rejected rather than
  // silently choosing one. Quoted flag-looking text is never treated as a flag.
  const conditionFlags = tokens
    .map((token, index) => ({ token, index }))
    .filter(
      ({ token }) =>
        !token.fullyQuoted && (token.value === "--until" || token.value === "--until-cmd"),
    );
  if (conditionFlags.length > 1) return null;
  let condition: LoopCondition | undefined;
  const foundCondition = conditionFlags[0];
  if (foundCondition) {
    const value = tokens[foundCondition.index + 1];
    const atBoundary = foundCondition.index === 0 || foundCondition.index + 1 === tokens.length - 1;
    if (foundCondition.token.value === "--until-cmd") {
      // Unlike model conditions, commands must be explicitly quoted: this keeps
      // shell operators and option-looking substrings inside one unambiguous value.
      if (!atBoundary || !value?.fullyQuoted || !value.value.trim()) return null;
      condition = { kind: "command", command: value.value };
      rest = withoutRanges(rest, [[foundCondition.token.start, value.end]]);
    } else if (atBoundary && value?.value.trim()) {
      condition = { kind: "model", text: value.value.trim() };
      rest = withoutRanges(rest, [[foundCondition.token.start, value.end]]);
    }
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
  if (
    /\s--(?:max|until|until-cmd)\s*$/i.test(rest) ||
    /^--(?:max|until|until-cmd)\s*$/i.test(rest)
  ) {
    const token = rest.match(/--(max|until|until-cmd)\s*$/i)?.[0] ?? "--until";
    warnings.push(
      `"${token}" was not applied (missing or invalid value) and was kept as prompt text — ` +
        'usage: --until <condition>, --until-cmd "<command>", --max <N>, --unlimited.',
    );
  } else if (/\s--max\s+\S+/i.test(rest) && max === undefined) {
    // e.g. `--max ten` — present but not applied as a number.
    warnings.push(
      `"--max" was not applied (missing or invalid value) and was kept as prompt text — ` +
        "usage: --until <condition>, --max <N>, --unlimited.",
    );
  }

  let maxDefaulted = false;
  if (unlimited && max !== undefined) {
    warnings.push("both --max and --unlimited were set; --unlimited wins (no iteration cap).");
    max = undefined;
  } else if (unlimited) {
    max = undefined;
  } else if (max === undefined) {
    // Safety default from config (0 = user opted into unlimited-by-default).
    if (configuredDefault > 0) {
      max = configuredDefault;
      maxDefaulted = true;
    } else {
      unlimited = true;
      maxDefaulted = true;
    }
  }

  return {
    intervalMs,
    prompt: rest,
    ...(condition ? { condition } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(unlimited ? { unlimited: true } : {}),
    ...(maxDefaulted ? { maxDefaulted: true } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export interface LoopOptions extends ParsedLoop {
  id: string;
  /** Run one iteration and return the result text. */
  run: (prompt: string) => Promise<string>;
  /** Evaluate whether the discriminated stop condition has been satisfied. */
  evaluate?: (
    result: string,
    condition: LoopCondition,
    signal: AbortSignal,
  ) => Promise<{ done: boolean; reason: string }>;
  /** Called when the loop is stopped — lets the host abort an in-flight turn. */
  onStop?: () => void;
  emit: (event: UIEvent) => void;
  /** Override {@link MAX_UNTIL_EVAL_FAILURES} (from config.loop.maxUntilEvalFailures). */
  maxUntilEvalFailures?: number;
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
   * and, with no `--max`, loop forever. Stops after {@link MAX_UNTIL_EVAL_FAILURES}. */
  #evalFailStreak = 0;
  #evaluationAbort: AbortController | undefined;
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
    this.#evaluationAbort?.abort();
    this.#evaluationAbort = undefined;
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

    if (this.#opts.condition && this.#opts.evaluate) {
      const evaluationAbort = new AbortController();
      this.#evaluationAbort = evaluationAbort;
      try {
        const verdict = await this.#opts.evaluate(
          result,
          this.#opts.condition,
          evaluationAbort.signal,
        );
        if (this.#stopped) return;
        this.#evalFailStreak = 0;
        if (verdict.done) {
          this.stop(`condition met: ${verdict.reason}`);
          return;
        }
      } catch (err) {
        if (this.#stopped || evaluationAbort.signal.aborted) return;
        // Treat evaluation failure as "not yet" and keep looping — but a
        // PERSISTENTLY failing check (model unreachable / bad id) silently turns
        // `--until` into "never", so stop after a short streak instead of
        // burning iterations forever.
        this.#evalFailStreak += 1;
        const failCap = this.#opts.maxUntilEvalFailures ?? MAX_UNTIL_EVAL_FAILURES;
        const detail =
          err instanceof Error ? err.message.replace(/\s+/gu, " ").slice(0, 240) : "unknown error";
        if (this.#evalFailStreak >= failCap) {
          this.stop(
            `--until check failed ${this.#evalFailStreak}× in a row (${detail}) — stopping. ` +
              "/loop with a fixed evaluator or --max.",
          );
          return;
        }
        if (this.#evalFailStreak === 1 || this.#evalFailStreak % 5 === 0) {
          this.#opts.emit({
            type: "notice",
            level: "warn",
            message:
              `Loop --until check failed ${this.#evalFailStreak}× (${detail}); continues ` +
              `(stops after ${failCap}). /loop stop to cancel.`,
          });
        }
      } finally {
        if (this.#evaluationAbort === evaluationAbort) this.#evaluationAbort = undefined;
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
