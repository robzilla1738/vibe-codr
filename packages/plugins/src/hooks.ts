/** Typed payloads for each lifecycle hook. Handlers may mutate and return them. */
export interface HookPayloads {
  "session.start": { sessionId: string };
  "user.prompt.submit": { text: string; deny?: boolean };
  "tool.before.execute": {
    toolName: string;
    input: unknown;
    deny?: boolean;
    reason?: string;
  };
  // PostToolUse-equivalent: the tool ALREADY ran. A handler may append
  // `additionalContext` (delimited onto the result the model reads next step) or
  // set `deny:true` (+`reason`) to hide/override the result with an isError.
  "tool.after.execute": {
    toolName: string;
    output: unknown;
    additionalContext?: string;
    deny?: boolean;
    reason?: string;
  };
  "step.finish": { sessionId: string };
  "assistant.message": { sessionId: string; text: string };
  // Stop-equivalent: fired when the engine queue fully drains. A handler may set
  // `continue:true` (+`reason`) to inject one more turn instead of settling idle
  // (the engine hard-bounds the number of continuations per user prompt).
  "session.idle": { sessionId: string; continue?: boolean; reason?: string };
  "session.end": { sessionId: string };
}

export type HookName = keyof HookPayloads;

/** Per-handler wall-clock deadline. A never-resolving plugin handler is awaited
 * on hot paths (session.idle inside the drain loop, user.prompt.submit at every
 * turn start, tool.before/after.execute, step.finish) — without a bound it would
 * hang the engine. A timeout is treated exactly like a throw: reported via
 * onError, the chain continues with the current payload. Mirrors config-hooks. */
const HANDLER_TIMEOUT_MS = 10_000;

export type HookHandler<N extends HookName> = (
  payload: HookPayloads[N],
) => HookPayloads[N] | void | Promise<HookPayloads[N] | void>;

/**
 * In-process, ordered, await-able hook dispatcher. Each handler may return a
 * modified payload that becomes the input to the next handler (and the result).
 */
// Handlers are stored loosely (per-name homogeneity is enforced by `on`'s
// generic signature); the public API remains fully typed.
type AnyHandler = (payload: unknown) => unknown | Promise<unknown>;

export class HookBus {
  #handlers = new Map<HookName, AnyHandler[]>();
  /** Notified when a handler throws (engine wires it to a UI notice/log). */
  #onError?: (name: HookName, err: Error) => void;
  /** Per-handler deadline (overridable for tests). */
  #timeoutMs: number;

  constructor(onError?: (name: HookName, err: Error) => void, timeoutMs = HANDLER_TIMEOUT_MS) {
    this.#onError = onError;
    this.#timeoutMs = timeoutMs;
  }

  on<N extends HookName>(name: N, handler: HookHandler<N>): void {
    const list = this.#handlers.get(name) ?? [];
    list.push(handler as AnyHandler);
    this.#handlers.set(name, list);
  }

  async run<N extends HookName>(
    name: N,
    payload: HookPayloads[N],
  ): Promise<HookPayloads[N]> {
    let current = payload;
    for (const handler of this.#handlers.get(name) ?? []) {
      // Isolate each handler: one throwing OR HANGING plugin must not abort the
      // turn or skip the remaining handlers in the chain. A per-handler deadline
      // bounds the await; a timeout surfaces through #onError like any throw. The
      // abandoned promise keeps running (unavoidable in-process) but the chain
      // proceeds.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          Promise.resolve(handler(current)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`hook handler for "${name}" timed out after ${this.#timeoutMs}ms`)),
              this.#timeoutMs,
            );
          }),
        ]);
        if (next) current = next as HookPayloads[N];
      } catch (err) {
        this.#onError?.(name, err as Error);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return current;
  }
}
