import { test, expect } from "bun:test";
import { createFetchCache } from "./fetch-cache.ts";

test("serves a fresh value from cache without re-running produce", async () => {
  let calls = 0;
  const cache = createFetchCache({ ttlMs: 1000, now: () => 0 });
  const produce = async () => `v${++calls}`;
  expect((await cache.through("k", produce)).text).toBe("v1");
  expect((await cache.through("k", produce)).text).toBe("v1"); // cached, no 2nd call
  expect(calls).toBe(1);
});

test("re-fetches once the TTL has elapsed", async () => {
  let calls = 0;
  let clock = 0;
  const cache = createFetchCache({ ttlMs: 1000, now: () => clock });
  const produce = async () => `v${++calls}`;
  expect((await cache.through("k", produce)).text).toBe("v1");
  clock = 1500; // past TTL
  expect((await cache.through("k", produce)).text).toBe("v2");
  expect(calls).toBe(2);
});

test("stale-on-failure: a failed produce serves the last cached value", async () => {
  let clock = 0;
  const cache = createFetchCache({ ttlMs: 1000, now: () => clock });
  await cache.through("k", async () => "good");
  clock = 2000; // stale now
  const res = await cache.through("k", async () => {
    throw new Error("network down");
  });
  expect(res.text).toBe("good");
  expect(res.stale).toBe(true);
});

test("propagates the error when there's nothing cached to fall back to", async () => {
  const cache = createFetchCache({ ttlMs: 1000, now: () => 0 });
  await expect(
    cache.through("cold", async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
});

test("evicts least-recently-used entries past maxEntries", async () => {
  const cache = createFetchCache({ ttlMs: 10_000, maxEntries: 2, now: () => 0 });
  await cache.through("a", async () => "A");
  await cache.through("b", async () => "B");
  await cache.through("a", async () => "A2"); // touch "a" → "b" becomes LRU (a stays fresh)
  await cache.through("c", async () => "C"); // inserting "c" evicts "b"
  // "b" was evicted → produce runs again; "a" is still cached from its first store.
  let bCalls = 0;
  await cache.through("b", async () => {
    bCalls++;
    return "B2";
  });
  expect(bCalls).toBe(1);
});

test("concurrent identical fetches coalesce into one produce() call", async () => {
  const cache = createFetchCache({ ttlMs: 60_000 });
  let calls = 0;
  let release!: (v: string) => void;
  const gate = new Promise<string>((r) => (release = r));
  const produce = () => {
    calls++;
    return gate;
  };
  const [a, b, c] = [cache.through("u", produce), cache.through("u", produce), cache.through("u", produce)];
  release("shared");
  const results = await Promise.all([a, b, c]);
  expect(calls).toBe(1);
  expect(results.every((r) => r.text === "shared")).toBe(true);
});

test("a failed in-flight fetch is evicted so the next attempt retries", async () => {
  const cache = createFetchCache({ ttlMs: 60_000 });
  let calls = 0;
  await expect(
    cache.through("u", async () => {
      calls++;
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  const ok = await cache.through("u", async () => {
    calls++;
    return "recovered";
  });
  expect(calls).toBe(2);
  expect(ok.text).toBe("recovered");
});
