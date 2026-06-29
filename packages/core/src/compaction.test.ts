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

/** Assert the contract every compaction result must satisfy. */
function expectValidContext(messages: ModelMessage[]): void {
  // First message must be a user turn (Anthropic requires this).
  expect(messages[0]!.role).toBe("user");
  // No two consecutive same-role messages (strict alternation).
  for (let i = 1; i < messages.length; i++) {
    expect(messages[i]!.role).not.toBe(messages[i - 1]!.role);
  }
}

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
  // The summary is folded into the leading user turn (recent[0] is a user
  // message here), so the result is the 6 preserved messages — not 7 — and stays
  // alternation-safe.
  expect(result!.messages).toHaveLength(6);
  expect(result!.messages[0]!.content).toContain("CONDENSED");
  expect(result!.messages.at(-1)).toEqual(messages.at(-1)!);
  expect(result!.freed).toBeGreaterThan(0);
  expectValidContext(result!.messages);
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
  expectValidContext(result!.messages);
});

test("the summary never creates two consecutive user turns", async () => {
  // recent window starts on a user message → summary must fold in, not stack.
  const messages = msgs(11); // [0..10], slice keep:4 → [7,8,9,10] = a/u/a/u → starts assistant
  const startsUser = msgs(12); // slice keep:4 → [8,9,10,11] = u/a/u/a → starts user
  for (const m of [messages, startsUser]) {
    const result = await compactMessages(m, {
      contextWindow: 10,
      threshold: 0,
      keep: 4,
      force: true,
      summarize: async () => "SUM",
    });
    expect(result!.messages[0]!.content).toContain("SUM");
    expectValidContext(result!.messages);
  }
});
