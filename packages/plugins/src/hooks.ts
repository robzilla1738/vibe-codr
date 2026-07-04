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

  constructor(onError?: (name: HookName, err: Error) => void) {
    this.#onError = onError;
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
      // Isolate each handler: one throwing plugin must not abort the turn or
      // skip the remaining handlers in the chain.
      try {
        const next = await handler(current);
        if (next) current = next as HookPayloads[N];
      } catch (err) {
        this.#onError?.(name, err as Error);
      }
    }
    return current;
  }
}
