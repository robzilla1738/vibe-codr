/**
 * A tiny cache-through store for fetched text, keyed by URL: within the TTL a
 * repeat fetch of the same document is served from memory (docs pages, changelogs
 * and raw files get re-read constantly by an agent), and on a fetch *failure* a
 * still-cached copy is served rather than propagating the error (stale-on-failure).
 * In-process and bounded (LRU); the clock is injectable so tests stay deterministic.
 */

export interface FetchCache {
  /**
   * Serve `key` from cache when fresh; otherwise run `produce()`, cache its
   * result, and return it. If `produce()` throws and a cached value exists, that
   * value is returned with `stale: true` instead of the error propagating.
   */
  through(key: string, produce: () => Promise<string>): Promise<{ text: string; stale: boolean }>;
  /** Drop all entries (test hook / manual invalidation). */
  clear(): void;
}

export interface FetchCacheOptions {
  /** Entries older than this are re-fetched. */
  ttlMs: number;
  /** LRU ceiling on retained entries. Default 256. */
  maxEntries?: number;
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number;
}

export function createFetchCache(opts: FetchCacheOptions): FetchCache {
  const entries = new Map<string, { text: string; storedAt: number }>();
  const maxEntries = opts.maxEntries ?? 256;
  const clock = opts.now ?? (() => Date.now());

  return {
    async through(key, produce) {
      const now = clock();
      const hit = entries.get(key);
      if (hit && now - hit.storedAt < opts.ttlMs) {
        // Refresh LRU recency (Map preserves insertion order).
        entries.delete(key);
        entries.set(key, hit);
        return { text: hit.text, stale: false };
      }
      try {
        const text = await produce();
        entries.set(key, { text, storedAt: now });
        while (entries.size > maxEntries) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          entries.delete(oldest);
        }
        return { text, stale: false };
      } catch (err) {
        // Stale-on-failure: a transient error shouldn't lose a good prior copy.
        if (hit) return { text: hit.text, stale: true };
        throw err;
      }
    },
    clear() {
      entries.clear();
    },
  };
}
