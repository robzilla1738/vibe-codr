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
    return queue;
  }

  close(): void {
    for (const queue of this.#subscribers) queue.close();
    this.#subscribers.clear();
  }
}
