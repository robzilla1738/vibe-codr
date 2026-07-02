import { isOverloadError } from "./retry.ts";

/**
 * A tree-global adaptive concurrency gate on agent TURNS. Honesty note: the
 * session wraps its entire multi-step `streamText` turn (provider calls AND
 * the tool executions between them) in one slot — so this bounds concurrent
 * *turns*, which is an over-approximation of concurrent provider requests (a
 * slot is held while a long bash/test run executes). That is deliberate: with
 * the single-streamText loop there is no per-request seam to gate on, and
 * whole-turn gating still prevents the failure it exists for — a deep fan-out
 * stampeding the provider. AIMD (additive increase, multiplicative decrease)
 * lowers the ceiling on 429/overloaded and recovers it gradually. The default
 * ceiling is high enough to be a no-op for ordinary single-session use.
 * (True per-request gating would need a fetch-level wrapper — future work.)
 *
 * Slot suspension ({@link Limiter.releaseSlot} / {@link Limiter.acquireSlot}):
 * because a whole-turn slot is held across a parent's spawned children too, a
 * parent that fans out and AWAITS its children would hold its slot while those
 * children queue on the very same limiter — a hold-and-wait that deadlocks a deep
 * or recursive fan-out (its only prior escape was the per-subagent wall-clock
 * timeout, which `subagent.timeoutMs:0` disables). But while a spawn tool awaits
 * its children the parent makes NO provider call, so handing its slot back for
 * that span TIGHTENS the provider-concurrency invariant rather than violating it.
 * `releaseSlot()` returns the current holder's slot to a queued waiter exactly
 * like a normal completion; `acquireSlot()` re-takes one exactly like a normal
 * acquire. They MUST be paired — every `releaseSlot()` is followed by an
 * `acquireSlot()` that completes BEFORE the wrapped `run()` continues, or `run()`'s
 * finally-release over-decrements `active`. The pairing discipline (ref-counted so
 * N parallel spawns in one step release/re-acquire exactly once) lives in
 * `Session.suspendLimiterSlot`; nothing else should call these directly.
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
  /**
   * Hand the CURRENT holder's slot back to a queued waiter for a span in which the
   * caller makes no provider call (a parent awaiting spawned children). Wakes a
   * queued waiter exactly like a normal release. MUST be paired with a later
   * {@link acquireSlot} that completes before the wrapping `run()` resumes — see
   * the doctrine note above. Only `Session.suspendLimiterSlot` may call it.
   */
  releaseSlot(): void;
  /**
   * Re-take a slot previously handed back by {@link releaseSlot}, queueing behind
   * the ceiling exactly like `run()`'s own acquire. `signal` (if given) abandons a
   * queued wait on abort like {@link run}; the suspend pairing deliberately passes
   * none — the re-acquire must complete to keep `active` balanced.
   */
  acquireSlot(signal?: AbortSignal): Promise<void>;
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
    // The suspend/resume primitives reuse the SAME release/acquire mechanics the
    // run() slot uses: releaseSlot pumps a queued waiter, acquireSlot queues if the
    // ceiling is full. So a released parent slot wakes a queued child exactly as a
    // completed run would, and a re-acquire waits its turn like any other caller.
    releaseSlot(): void {
      release();
    },
    acquireSlot(signal?: AbortSignal): Promise<void> {
      return acquire(signal);
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
