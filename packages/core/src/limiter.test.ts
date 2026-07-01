import { test, expect } from "bun:test";
import { createLimiter } from "./limiter.ts";

test("never runs more than the ceiling concurrently; the rest queue", async () => {
  const lim = createLimiter({ max: 3 });
  let active = 0;
  let peak = 0;
  const run = () =>
    lim.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
  await Promise.all(Array.from({ length: 10 }, run));
  expect(peak).toBe(3); // exactly the ceiling, never more
  expect(active).toBe(0);
});

test("halves the ceiling on overload (AIMD) and floors at min", async () => {
  const lim = createLimiter({ max: 8, min: 2 });
  expect(lim.limit).toBe(8);
  const overload = (status: number) => () => Promise.reject({ status });
  await lim.run(overload(429)).catch(() => {});
  expect(lim.limit).toBe(4); // multiplicative decrease
  await lim.run(overload(503)).catch(() => {});
  expect(lim.limit).toBe(2);
  await lim.run(overload(429)).catch(() => {});
  expect(lim.limit).toBe(2); // floored at min
});

test("recovers the ceiling additively after consecutive successes", async () => {
  const lim = createLimiter({ max: 8, min: 2, increaseEvery: 1 });
  await lim.run(() => Promise.reject({ status: 429 })).catch(() => {}); // → 4
  await lim.run(() => Promise.reject({ status: 429 })).catch(() => {}); // → 2
  expect(lim.limit).toBe(2);
  await lim.run(async () => "ok");
  expect(lim.limit).toBe(3); // additive +1
  await lim.run(async () => "ok");
  expect(lim.limit).toBe(4);
});

test("a non-overload error does not lower the ceiling", async () => {
  const lim = createLimiter({ max: 8 });
  await lim.run(async () => {
    throw new Error("a logic bug, not back-pressure");
  }).catch(() => {});
  expect(lim.limit).toBe(8);
});

test("a queued call whose signal aborts rejects and frees its ancestor's slot", async () => {
  // Ceiling of 1: the first call holds the only slot; a second, queued call must
  // be able to abandon its wait (a subagent timeout) instead of hanging forever.
  const lim = createLimiter({ max: 1, min: 1 });
  let release!: () => void;
  const holder = lim.run(() => new Promise<void>((r) => (release = r)));
  const ac = new AbortController();
  let queuedRan = false;
  const queued = lim
    .run(async () => {
      queuedRan = true;
    }, ac.signal)
    .catch((e) => (e as Error).name);
  // The queued call is waiting behind the holder; aborting must reject it.
  ac.abort();
  expect(await queued).toBe("AbortError");
  expect(queuedRan).toBe(false);
  // Aborting the waiter must not have leaked a slot: a fresh call still admits
  // after the holder releases.
  release();
  await holder;
  let after = false;
  await lim.run(async () => {
    after = true;
  });
  expect(after).toBe(true);
  expect(lim.active).toBe(0);
});

test("an already-aborted signal rejects immediately without taking a slot", async () => {
  const lim = createLimiter({ max: 2 });
  const ac = new AbortController();
  ac.abort();
  await expect(lim.run(async () => "x", ac.signal)).rejects.toThrow(/abort/i);
  expect(lim.active).toBe(0);
});

test("with a high ceiling a single call never waits (no-op for single-session)", async () => {
  const lim = createLimiter({ max: 16 });
  let started = false;
  await lim.run(async () => {
    started = true;
  });
  expect(started).toBe(true);
  expect(lim.active).toBe(0);
});
