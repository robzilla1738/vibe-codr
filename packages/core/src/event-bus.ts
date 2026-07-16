import { AsyncQueue, type UIEvent } from "@vibe/shared";

/**
 * Fan-out event bus: each subscriber gets its own buffered async iterable, so
 * a TUI and a headless printer can both observe the same stream without
 * stealing events from each other.
 *
 * Late-join catch-up (BUG-085): bootstrap emits security/sandbox notices and
 * git-updated before the UI has called `events()`. Without a history buffer
 * those would only reach early internal subscribers (e.g. the plan watcher)
 * and be lost forever for the TUI. Every new subscriber is replayed the
 * bounded recent history, then receives live events.
 */
export class EventBus {
  #subscribers = new Set<AsyncQueue<UIEvent>>();
  /** Recent emits for late subscribers. Cap bounds memory for long sessions. */
  #history: UIEvent[] = [];
  static readonly HISTORY_CAP = 64;

  emit(event: UIEvent): void {
    this.#history.push(event);
    if (this.#history.length > EventBus.HISTORY_CAP) this.#history.shift();
    for (const queue of this.#subscribers) queue.push(event);
  }

  subscribe(): AsyncIterable<UIEvent> {
    const queue = new AsyncQueue<UIEvent>();
    // Catch-up: a UI that attaches after bootstrap still sees notices/git.
    // Early subscribers that were already live during those emits got them
    // via `emit` and are not double-delivered here (they already left the
    // history path at emit time).
    for (const e of this.#history) queue.push(e);
    this.#subscribers.add(queue);
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
    // End current subscribers and clear history. New subscribe() is still
    // allowed (tests re-use a bus across collect() rounds after close).
    for (const queue of [...this.#subscribers]) queue.close();
    this.#subscribers.clear();
    this.#history = [];
  }
}
