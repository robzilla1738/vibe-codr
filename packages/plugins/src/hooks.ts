/** Typed payloads for each lifecycle hook. Handlers may mutate and return them. */
export interface HookPayloads {
  "session.start": { sessionId: string };
  "user.prompt.submit": { text: string };
  "tool.before.execute": {
    toolName: string;
    input: unknown;
    deny?: boolean;
    reason?: string;
  };
  "tool.after.execute": { toolName: string; output: unknown };
  "step.finish": { sessionId: string };
  "assistant.message": { sessionId: string; text: string };
  "session.idle": { sessionId: string };
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
      const next = await handler(current);
      if (next) current = next as HookPayloads[N];
    }
    return current;
  }
}
