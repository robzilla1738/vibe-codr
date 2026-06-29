import type { UIEvent } from "@vibe/shared";

export interface ParsedLoop {
  intervalMs: number;
  prompt: string;
  until?: string;
  max?: number;
}

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** Parse a duration token like "30s", "5m", "2h" into milliseconds. */
export function parseDuration(token: string): number | null {
  const m = token.match(/^(\d+)(s|m|h)$/);
  if (!m) return null;
  const n = Number(m[1]);
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

  let max: number | undefined;
  const maxMatch = rest.match(/--max\s+(\d+)/);
  if (maxMatch) {
    max = Number(maxMatch[1]);
    rest = rest.replace(maxMatch[0], "").trim();
  }

  let until: string | undefined;
  const untilMatch = rest.match(/--until\s+(.+)$/);
  if (untilMatch) {
    until = untilMatch[1]!.trim().replace(/^["']|["']$/g, "");
    rest = rest.replace(untilMatch[0], "").trim();
  }

  // Optional leading interval token.
  let intervalMs = DEFAULT_INTERVAL_MS;
  const firstSpace = rest.indexOf(" ");
  const firstToken = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  const parsedInterval = parseDuration(firstToken);
  if (parsedInterval !== null) {
    intervalMs = parsedInterval;
    rest = firstSpace === -1 ? "" : rest.slice(firstSpace + 1).trim();
  }

  if (!rest) return null;
  return { intervalMs, prompt: rest, ...(until ? { until } : {}), ...(max ? { max } : {}) };
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
      this.stop(`iteration failed: ${(err as Error).message}`);
      return;
    }
    if (this.#stopped) return;

    if (this.#opts.until && this.#opts.evaluate) {
      try {
        const verdict = await this.#opts.evaluate(result, this.#opts.until);
        if (verdict.done) {
          this.stop(`condition met: ${verdict.reason}`);
          return;
        }
      } catch {
        // Treat evaluation failure as "not yet" and keep looping.
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
