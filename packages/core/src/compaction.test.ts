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

test("estimateTokens counts an image part flat, not by its raw bytes", () => {
  // A 500KB image: JSON.stringify-ing the Uint8Array would invent millions of
  // "chars" (~5-7/byte); the flat cost keeps the estimate sane.
  const bytes = new Uint8Array(500_000);
  const withImage: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", image: bytes, mediaType: "image/png" },
      ],
    },
  ];
  // Far below the ~hundreds-of-thousands of tokens the byte-serialized form gave.
  expect(estimateTokens(withImage)).toBeLessThan(2_000);
});

test("currentTokens (the real prompt size) drives the trigger, not the estimate", async () => {
  // Messages estimate well under threshold, but the provider's real prompt
  // (system + tool schemas) is over it — compaction must still fire.
  const messages = msgs(20);
  const estimate = estimateTokens(messages);
  const contextWindow = 100_000;
  // Estimate-only would NOT trip (estimate << 0.75 * window) ...
  const noTrip = await compactMessages(messages, {
    contextWindow,
    threshold: 0.75,
    keep: 6,
    summarize: async () => "S",
  });
  expect(noTrip).toBeNull();
  // ... but with the true prompt size over the threshold, it does.
  const tripped = await compactMessages(messages, {
    contextWindow,
    threshold: 0.75,
    keep: 6,
    currentTokens: 0.8 * contextWindow,
    summarize: async () => "S",
  });
  expect(estimate).toBeLessThan(0.75 * contextWindow);
  expect(tripped).not.toBeNull();
  // `freed` reflects the message reduction, not the system/tool overhead carried
  // in currentTokens.
  expect(tripped!.freed).toBeGreaterThan(0);
  expect(tripped!.freed).toBeLessThanOrEqual(estimate);
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

/**
 * Assert no `tool` result message is orphaned from its `tool-call`: every
 * `role: "tool"` message must be immediately preceded by an `assistant` message
 * (the turn that issued the call), or by another `tool` message in the same step.
 * A leading or summary-preceded `tool` message is the 400 we are guarding against.
 */
function expectNoOrphanToolResult(messages: ModelMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role !== "tool") continue;
    const prev = messages[i - 1];
    expect(prev).toBeDefined();
    expect(prev!.role === "assistant" || prev!.role === "tool").toBe(true);
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

test("the kept window never begins with an orphaned tool result", async () => {
  // A real turn: user → assistant(tool-call) → tool(result) → assistant(text).
  // `response.messages` records the tool result as its own `role: "tool"` message,
  // so a naive tail slice that lands on it would orphan the result from its call.
  const u = (i: number): ModelMessage => ({
    role: "user",
    content: `ask ${i} with some padding text to add tokens`,
  });
  const aCall = (id: string): ModelMessage => ({
    role: "assistant",
    content: [
      { type: "text", text: "working on it with padding" },
      { type: "tool-call", toolCallId: id, toolName: "read", input: { path: "a.ts" } },
    ],
  });
  const tRes = (id: string): ModelMessage => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: "ok" } }],
  });
  const aText = (i: number): ModelMessage => ({
    role: "assistant",
    content: `done ${i} with some padding text to add tokens`,
  });

  const messages: ModelMessage[] = [];
  for (let i = 0; i < 5; i++) {
    messages.push(u(i), aCall(`t${i}`), tRes(`t${i}`), aText(i));
  }

  // Sweep every `keep` so the slice boundary lands on each role in turn — the
  // tool-message cases are the ones a naive slice would corrupt.
  for (let keep = 1; keep <= messages.length; keep++) {
    const result = await compactMessages(messages, {
      contextWindow: 10,
      threshold: 0,
      keep,
      force: true,
      summarize: async () => "RECAP",
    });
    if (!result) continue; // boundary collapsed past anything older to summarize
    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[0]!.content).toContain("RECAP");
    expectNoOrphanToolResult(result.messages);
  }
});
