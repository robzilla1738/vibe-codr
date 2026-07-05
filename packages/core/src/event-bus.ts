import { AsyncQueue, type UIEvent } from "@vibe/shared";

/**
 * Fan-out event bus: each subscriber gets its own buffered async iterable, so
 * a TUI and a headless printer can both observe the same stream without
 * stealing events from each other.
 */
export class EventBus {
  #subscribers = new Set<AsyncQueue<UIEvent>>();

  emit(event: UIEvent): void {
    for (const queue of this.#subscribers) queue.push(event);
  }

  subscribe(): AsyncIterable<UIEvent> {
    const queue = new AsyncQueue<UIEvent>();
    this.#subscribers.add(queue);
    // Wrap the queue in a generator whose finally detaches it: a consumer that
    // `break`s / `return`s / throws out of its `for await` (a closed TUI
    // sub-view, an abandoned engine.events() reader) is removed from the fan-out
    // instead of buffering every future event for the process lifetime.
    return this.#consume(queue);
  }

  async *#consume(queue: AsyncQueue<UIEvent>): AsyncGenerator<UIEvent> {
    try {
      yield* queue;
    } finally {
      this.#subscribers.delete(queue);
      queue.close();
    }
  }

  close(): void {
    for (const queue of this.#subscribers) queue.close();
    this.#subscribers.clear();
  }
}
