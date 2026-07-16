import { describe, expect, it } from "vitest";
import { CATALOG_CACHE_MAX_ENTRIES, CatalogCache } from "./catalog-cache";

describe("CatalogCache", () => {
  it("retains only the most recently used full catalogs", () => {
    const cache = new CatalogCache();
    cache.set("models", [{ id: "m" }]);
    cache.set("agents", [{ name: "a" }]);
    expect(cache.get<{ id: string }>("models")).toEqual([{ id: "m" }]);

    cache.set("skills", [{ name: "s" }]);

    expect(cache.size).toBe(CATALOG_CACHE_MAX_ENTRIES);
    expect(cache.get("agents")).toBeNull();
    expect(cache.get("models")).toEqual([{ id: "m" }]);
    expect(cache.get("skills")).toEqual([{ name: "s" }]);
  });

  it("shares the immutable response array instead of duplicating large datasets", () => {
    const cache = new CatalogCache();
    const source = [{ id: "m" }];
    cache.set("models", source);
    expect(cache.get("models")).toBe(source);
  });

  it("supports targeted invalidation and full session invalidation", () => {
    const cache = new CatalogCache();
    cache.set("models", [1]);
    cache.set("providers", [2]);
    cache.delete("models");
    expect(cache.get("models")).toBeNull();
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
