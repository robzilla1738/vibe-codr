import { test, expect } from "bun:test";
import { AsyncQueue } from "./async-queue.ts";

test("buffers values pushed before iteration", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.push(2);
  q.close();
  const seen: number[] = [];
  for await (const v of q) seen.push(v);
  expect(seen).toEqual([1, 2]);
});

test("delivers values pushed after iteration starts", async () => {
  const q = new AsyncQueue<string>();
  const collected: string[] = [];
  const consumer = (async () => {
    for await (const v of q) collected.push(v);
  })();
  q.push("a");
  q.push("b");
  q.close();
  await consumer;
  expect(collected).toEqual(["a", "b"]);
});
