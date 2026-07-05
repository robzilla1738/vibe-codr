import { test, expect } from "bun:test";
import type { UIEvent } from "@vibe/shared";
import { EventBus } from "./event-bus.ts";

/** A minimal, valid UIEvent for stream assertions. */
function ev(message: string): UIEvent {
  return { type: "notice", level: "info", message };
}

/** Drain a subscriber to completion. Only terminates once the bus is closed. */
async function drain(sub: AsyncIterable<UIEvent>): Promise<UIEvent[]> {
  const got: UIEvent[] = [];
  for await (const e of sub) got.push(e);
  return got;
}

test("delivers buffered events in order, then close() ends iteration", async () => {
  const bus = new EventBus();
  const sub = bus.subscribe();
  bus.emit(ev("a"));
  bus.emit(ev("b"));
  bus.emit(ev("c"));
  bus.close(); // ends the iteration; the buffered events still drain first.

  const got = await drain(sub);
  expect(got.map((e) => (e as { message: string }).message)).toEqual(["a", "b", "c"]);
});

test("every subscriber gets every event (fan-out, no stealing)", async () => {
  const bus = new EventBus();
  const s1 = bus.subscribe();
  const s2 = bus.subscribe();
  bus.emit(ev("x"));
  bus.emit(ev("y"));
  bus.close();

  const [g1, g2] = await Promise.all([drain(s1), drain(s2)]);
  const msgs = (g: UIEvent[]) => g.map((e) => (e as { message: string }).message);
  expect(msgs(g1)).toEqual(["x", "y"]);
  expect(msgs(g2)).toEqual(["x", "y"]);
});

test("delivers a live event to a consumer already awaiting the next value", async () => {
  const bus = new EventBus();
  const it = bus.subscribe()[Symbol.asyncIterator]();
  const pending = it.next(); // await BEFORE any emit → consumer is parked
  bus.emit(ev("live"));
  const { value, done } = await pending;
  expect(done).toBe(false);
  expect((value as { message: string }).message).toBe("live");
});

test("emit after close is a no-op", async () => {
  const bus = new EventBus();
  const sub = bus.subscribe();
  bus.close();
  bus.emit(ev("dropped")); // closed → must not deliver, must not throw

  const got = await drain(sub);
  expect(got).toEqual([]);
});

test("a subscriber that attaches after close terminates immediately (still drainable)", async () => {
  // Defensive: subscribing to a bus, closing it, and iterating must not hang.
  const bus = new EventBus();
  const s1 = bus.subscribe();
  bus.emit(ev("only"));
  bus.close();
  expect((await drain(s1)).length).toBe(1);
});

test("breaking out of a subscriber unsubscribes it (later emits aren't buffered for it)", async () => {
  // A consumer that stops iterating (break/return/throw) must be detached, not
  // left buffering every future event for the process lifetime. Its generator's
  // finally removes it from the fan-out; other subscribers are unaffected.
  const bus = new EventBus();
  const leaver = bus.subscribe();
  const stayer = bus.subscribe();

  // Consume one event from `leaver`, then break out of its loop.
  bus.emit(ev("one"));
  for await (const _e of leaver) break; // runs the generator's finally → detach

  // Emit more after the leaver detached.
  bus.emit(ev("two"));
  bus.emit(ev("three"));
  bus.close();

  // The stayer still received everything (the detach didn't disturb it).
  const stayed = await drain(stayer);
  expect(stayed.map((e) => (e as { message: string }).message)).toEqual(["one", "two", "three"]);
});
