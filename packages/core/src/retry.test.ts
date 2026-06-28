import { test, expect } from "bun:test";
import { withRetry, isTransientError } from "./retry.ts";

const noSleep = async () => {};

test("isTransientError classifies network and rate-limit errors", () => {
  expect(isTransientError({ status: 429 })).toBe(true);
  expect(isTransientError({ status: 503 })).toBe(true);
  expect(isTransientError({ code: "ECONNRESET" })).toBe(true);
  expect(isTransientError(new Error("fetch failed"))).toBe(true);
  expect(isTransientError({ status: 400 })).toBe(false);
  expect(isTransientError(new Error("syntax error"))).toBe(false);
});

test("withRetry retries transient failures then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw { status: 503 };
      return "ok";
    },
    { maxAttempts: 5, baseDelayMs: 0, sleep: noSleep },
  );
  expect(result).toBe("ok");
  expect(calls).toBe(3);
});

test("withRetry does not retry a non-transient error", async () => {
  let calls = 0;
  await expect(
    withRetry(
      async () => {
        calls++;
        throw { status: 400 };
      },
      { maxAttempts: 5, baseDelayMs: 0, sleep: noSleep },
    ),
  ).rejects.toEqual({ status: 400 });
  expect(calls).toBe(1);
});

test("withRetry gives up after maxAttempts and rethrows", async () => {
  let calls = 0;
  await expect(
    withRetry(
      async () => {
        calls++;
        throw { status: 503 };
      },
      { maxAttempts: 2, baseDelayMs: 0, sleep: noSleep },
    ),
  ).rejects.toEqual({ status: 503 });
  expect(calls).toBe(3); // initial + 2 retries
});

test("withRetry backs off exponentially", async () => {
  const delays: number[] = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls++;
      if (calls < 4) throw { status: 503 };
      return 1;
    },
    { maxAttempts: 5, baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) },
  );
  expect(delays).toEqual([100, 200, 400]);
});
