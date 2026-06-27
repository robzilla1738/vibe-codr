/**
 * A single-producer, single-consumer async queue that is also an async
 * iterable. The engine pushes `UIEvent`s in; the UI iterates them out. Values
 * pushed before a consumer attaches are buffered, so no events are lost.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #buffer: T[] = [];
  #resolvers: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const resolve = this.#resolvers.shift();
    if (resolve) {
      resolve({ value, done: false });
    } else {
      this.#buffer.push(value);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    let resolve = this.#resolvers.shift();
    while (resolve) {
      resolve({ value: undefined, done: true });
      resolve = this.#resolvers.shift();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.#buffer.length > 0) {
        yield this.#buffer.shift() as T;
        continue;
      }
      if (this.#closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.#resolvers.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}
