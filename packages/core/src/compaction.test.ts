import { test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { compactMessages, estimateTokens } from "./compaction.ts";

function msgs(n: number): ModelMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message number ${i} with some padding text to add tokens`,
  }));
}

test("estimateTokens grows with content", () => {
  expect(estimateTokens(msgs(2))).toBeLessThan(estimateTokens(msgs(20)));
});

test("does not compact below the threshold", async () => {
  const result = await compactMessages(msgs(4), {
    contextWindow: 100_000,
    threshold: 0.75,
    keep: 6,
    summarize: async () => "summary",
  });
  expect(result).toBeNull();
});

test("compacts when forced, preserving the most recent messages", async () => {
  const messages = msgs(20);
  const result = await compactMessages(messages, {
    contextWindow: 100_000,
    threshold: 0.75,
    keep: 6,
    force: true,
    summarize: async () => "CONDENSED",
  });
  expect(result).not.toBeNull();
  // 1 summary message + the 6 preserved recent messages.
  expect(result!.messages).toHaveLength(7);
  expect(result!.messages[0]!.content).toContain("CONDENSED");
  expect(result!.messages.at(-1)).toEqual(messages.at(-1)!);
  expect(result!.freed).toBeGreaterThan(0);
});

test("compacts when over the threshold", async () => {
  const messages = msgs(40);
  const tokens = estimateTokens(messages);
  const result = await compactMessages(messages, {
    contextWindow: tokens, // tiny window so we are well over threshold
    threshold: 0.5,
    keep: 4,
    summarize: async () => "S",
  });
  expect(result).not.toBeNull();
  expect(result!.messages).toHaveLength(5);
});
