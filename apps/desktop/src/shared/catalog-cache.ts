import { TtlLruCache } from "./ttl-lru-cache";

export type CatalogCacheKey = "models" | "providers" | "agents" | "skills" | "mcp";

/** Keep Models plus one related catalog hot without retaining every full RPC
 * dataset for the renderer lifetime. The open picker shares the cached array,
 * so this bounds idle retention without truncating or changing catalog results. */
export const CATALOG_CACHE_MAX_ENTRIES = 2;
export const CATALOG_CACHE_TTL_MS = 5 * 60_000;

export class CatalogCache {
  private readonly entries = new TtlLruCache<CatalogCacheKey, readonly unknown[]>(
    CATALOG_CACHE_MAX_ENTRIES,
    CATALOG_CACHE_TTL_MS,
  );

  get<T>(key: CatalogCacheKey): T[] | null {
    return (this.entries.get(key) as T[] | undefined) ?? null;
  }

  set<T>(key: CatalogCacheKey, items: readonly T[]): void {
    this.entries.set(key, items);
  }

  delete(key: CatalogCacheKey): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
