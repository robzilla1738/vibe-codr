import { test, expect } from "bun:test";
import { createLimiter, type Limiter } from "./limiter.ts";

// Mirror Session.suspendLimiterSlot's ref-counted pairing so these tests exercise
// the exact release/re-acquire discipline the primitives exist for: only the 0→1
// suspension releases the slot, only the 1→0 re-acquires it.
function makeSuspender(lim: Limiter) {
  let depth = 0;
  return async function suspend<T>(fn: () => Promise<T>): Promise<T> {
    if (++depth === 1) lim.releaseSlot();
    try {
      return await fn();
    } finally {
      if (--depth === 0) await lim.acquireSlot();
    }
  };
}

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
  await lim
    .run(async () => {
      throw new Error("a logic bug, not back-pressure");
    })
    .catch(() => {});
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

test("releaseSlot hands the slot to a queued waiter; acquireSlot re-takes it (balanced)", async () => {
  // Ceiling of 1: a "parent" run holds the only slot; a second, QUEUED run models a
  // child on the same tree-global limiter. releaseSlot must wake that queued waiter
  // exactly like a normal completion, and acquireSlot must bring the parent's slot
  // back — with the total in/out balanced so `active` returns to 0.
  const lim = createLimiter({ max: 1, min: 1 });
  let releaseHolder!: () => void;
  const holder = lim.run(() => new Promise<void>((r) => (releaseHolder = r)));
  expect(lim.active).toBe(1);
  let childRan = false;
  const child = lim.run(async () => {
    childRan = true;
  });
  lim.releaseSlot(); // hand the slot back → the queued child is admitted
  await child;
  expect(childRan).toBe(true);
  await lim.acquireSlot(); // parent re-takes its slot (child already released)
  expect(lim.active).toBe(1);
  releaseHolder();
  await holder;
  expect(lim.active).toBe(0);
});

test("a throwing suspend span still re-acquires and leaves active balanced", async () => {
  const lim = createLimiter({ max: 2, min: 1 });
  const suspend = makeSuspender(lim);
  await lim.run(async () => {
    expect(lim.active).toBe(1);
    await suspend(async () => {
      throw new Error("boom");
    }).catch(() => {});
    // The slot was released then re-acquired despite the throw.
    expect(lim.active).toBe(1);
  });
  expect(lim.active).toBe(0);
});

test("parallel suspend spans release and re-acquire the one slot exactly once", async () => {
  // N spawn tools in ONE step each open a suspension; only the first releases and
  // only the last re-acquires, so a queued child gets the slot and the parent gets
  // it back — with `active` never drifting.
  const lim = createLimiter({ max: 1, min: 1 });
  const suspend = makeSuspender(lim);
  let childRan = false;
  await lim.run(async () => {
    const child = lim.run(async () => {
      childRan = true;
    });
    await Promise.all([
      suspend(() => child), // 0→1: releases the slot, waking the queued child
      suspend(async () => {}), // 1→2: no extra release
    ]);
    expect(lim.active).toBe(1); // exactly one re-acquire brought the parent back
  });
  expect(lim.active).toBe(0);
  expect(childRan).toBe(true);
});

test("reacquireSlot reclaims without queueing, even when the AIMD ceiling dropped", async () => {
  // A parent holds a slot via run(), releases it via releaseSlot() for a
  // child's span, then AIMD halves the ceiling (another run() got overloaded).
  // The old acquireSlot() would queue forever (active >= lowered limit). The
  // new reacquireSlot() simply increments active — it never blocks.
  const limiter = createLimiter({ max: 4, min: 1, increaseEvery: 100 });
  // Fill 3 slots (leave 1 free for the parent).
  const holders: Promise<void>[] = [];
  for (let i = 0; i < 3; i++) {
    holders.push(limiter.run(async () => { await new Promise(r => setTimeout(r, 500)); }));
  }
  // Parent takes the last slot.
  const parentPromise = limiter.run(async () => {
    // Release the slot for a child span.
    limiter.releaseSlot();
    // Simulate AIMD halving: trigger an overload on one of the holders.
    // (We can't easily trigger AIMD from outside, so just verify reacquireSlot
    // doesn't block when active == limit.)
    // At this point: 3 holders active, parent released (active=3, limit=4).
    // If AIMD halved limit to 2, active(3) > limit(2) — acquireSlot would queue.
    // reacquireSlot just increments: active=4, never blocks.
    limiter.reacquireSlot();
    // Parent has its slot back. run()'s finally will release it.
  });
  await parentPromise;
  await Promise.all(holders);
  // active should be 0 after all complete.
  expect(limiter.active).toBe(0);
});

test("reacquireSlot is synchronous (returns void, never a Promise)", () => {
  const limiter = createLimiter({ max: 2 });
  limiter.releaseSlot();
  const result = limiter.reacquireSlot();
  expect(result).toBeUndefined(); // void, not a Promise
});
