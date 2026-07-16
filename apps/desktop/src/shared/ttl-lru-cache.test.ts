import { describe, expect, it } from "vitest";
import { TtlLruCache } from "./ttl-lru-cache";

describe("TtlLruCache", () => {
  it("expires entries and remains bounded", () => {
    const cache = new TtlLruCache<string, number>(2, 10);
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    expect(cache.get("a", 1)).toBe(1);
    cache.set("c", 3, 1);
    expect(cache.get("b", 1)).toBeUndefined();
    expect(cache.get("a", 9)).toBe(1);
    expect(cache.get("a", 10)).toBeUndefined();
    expect(cache.size).toBe(1);
  });
});
