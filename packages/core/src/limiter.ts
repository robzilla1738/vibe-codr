import { isOverloadError } from "./retry.ts";

/**
 * A tree-global adaptive concurrency gate in front of EVERY provider call. It
 * bounds how many model requests are in flight across the whole session tree at
 * once (distinct from the logical `subagent.maxParallel` fan-out cap), so a deep
 * fan-out can't stampede the provider — and it adapts: AIMD (additive increase,
 * multiplicative decrease) lowers the ceiling on 429/overloaded and recovers it
 * gradually. The default ceiling is high enough to be a no-op for ordinary
 * single-session use (one in-flight call out of N slots → never waits).
 */
export interface Limiter {
  /**
   * Run `fn` once a slot is free; record success/overload to adapt the ceiling.
   * If `signal` is provided and aborts while this call is still QUEUED (waiting
   * for a slot), the wait is abandoned and the returned promise rejects with an
   * AbortError — critical so a subagent whose wall-clock timeout fires while it's
   * blocked on `acquire()` can unwind instead of wedging its ancestors' slots
   * (which held tree-globally would otherwise deadlock a deep fan-out).
   */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Current concurrency ceiling. */
  readonly limit: number;
  /** Currently in-flight count. */
  readonly active: number;
}

export interface LimiterOptions {
  /** Initial + maximum ceiling. High → no-op for single-session use. Default 16. */
  max?: number;
  /** Floor the ceiling never drops below. Default 2 (clamped ≤ max). */
  min?: number;
  /** Classify an error as provider overload (back off). Default {@link isOverloadError}. */
  isOverload?: (err: unknown) => boolean;
  /** Consecutive successes between each additive +1 recovery step. Default 8. */
  increaseEvery?: number;
  /** Notified when the ceiling changes (engine wires it to a UIEvent). */
  onChange?: (limit: number) => void;
}

export function createLimiter(opts: LimiterOptions = {}): Limiter {
  const max = Math.max(1, Math.floor(opts.max ?? 16));
  const min = Math.max(1, Math.min(Math.floor(opts.min ?? 2), max));
  const isOverload = opts.isOverload ?? isOverloadError;
  const increaseEvery = Math.max(1, Math.floor(opts.increaseEvery ?? 8));

  let limit = max;
  let active = 0;
  let successes = 0;
  const waiters: Array<() => void> = [];

  /** Admit as many queued waiters as the current ceiling allows. */
  const pump = (): void => {
    while (active < limit && waiters.length) {
      active++;
      waiters.shift()!();
    }
  };
  const abortError = (): Error => {
    const e = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
  };
  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(abortError());
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      // A queued waiter that is aborted before it's admitted removes itself and
      // rejects, so it never occupies a slot and its ancestors can unwind.
      const waiter = (): void => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        reject(abortError());
      };
      waiters.push(waiter);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const release = (): void => {
    active--;
    pump();
  };
  const onSuccess = (): void => {
    if (limit >= max) return;
    if (++successes >= increaseEvery) {
      successes = 0;
      limit = Math.min(max, limit + 1);
      opts.onChange?.(limit);
      pump();
    }
  };
  const onOverload = (): void => {
    successes = 0;
    const next = Math.max(min, Math.floor(limit / 2));
    if (next !== limit) {
      limit = next;
      opts.onChange?.(limit);
    }
  };

  return {
    get limit() {
      return limit;
    },
    get active() {
      return active;
    },
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await acquire(signal);
      try {
        const result = await fn();
        onSuccess();
        return result;
      } catch (err) {
        if (isOverload(err)) onOverload();
        throw err;
      } finally {
        release();
      }
    },
  };
}
