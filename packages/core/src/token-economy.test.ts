import { test, expect } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { FreshnessRegistry } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";

/**
 * Token-economy guarantees for the prompt cache. The system prompt must stay
 * byte-stable across a session (so the whole conversation prefix caches), the
 * volatile working state rides in the newest user turn, and the conversation
 * cache breakpoint trails the last message every step. These pin the fixes for
 * the cross-turn cache-kill and per-step re-billing.
 */

function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({
      chunks: chunks as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}
const USAGE = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const reply = () =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "ok" },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop" as const, raw: undefined }, usage: USAGE },
  ]);

/** A registry that serves the mock model under the ANTHROPIC provider id, so the
 * Anthropic-gated caching path (cacheSystem / cacheConversation) actually runs. */
function anthropicRegistry(model: MockLanguageModelV3): ProviderRegistry {
  return new ProviderRegistry([
    {
      id: "anthropic",
      auth: { env: [], keyless: true },
      create: () => model,
      listModels: async () => [],
    },
  ]);
}

function hasCacheMarker(m: { providerOptions?: unknown } | undefined): boolean {
  const po = m?.providerOptions as { anthropic?: { cacheControl?: unknown } } | undefined;
  return Boolean(po?.anthropic?.cacheControl);
}

test("the system prompt is byte-stable across turns even when the task list changes", async () => {
  const prompts: { role: string; content: unknown }[][] = [];
  let call = 0;
  const replies = [reply(), reply()];
  const model = new MockLanguageModelV3({
    doStream: async (opts: { prompt?: unknown[] }) => {
      prompts.push((opts.prompt ?? []) as { role: string; content: unknown }[]);
      return replies[call++] as never;
    },
  });
  const session = new Session({
    config: defaultConfig(),
    registry: anthropicRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "anthropic/claude-test",
    mode: "execute",
  });

  session.setTasks([{ title: "first task", status: "in_progress" }]);
  await session.run("turn one");
  session.setTasks([
    { title: "first task", status: "completed" },
    { title: "second task", status: "in_progress" },
  ]);
  await session.run("turn two");

  const sysOf = (p: { role: string; content: unknown }[]) => {
    const s = p.find((m) => m.role === "system");
    return typeof s?.content === "string" ? s.content : JSON.stringify(s?.content);
  };
  // The system message is identical turn-to-turn despite the task-list change —
  // the whole cached conversation prefix behind it survives. (BASE may NAME the
  // CURRENT TASKS block as a stable pointer; the volatile ENTRIES are not there.)
  expect(sysOf(prompts[0]!)).toBe(sysOf(prompts[1]!));
  expect(sysOf(prompts[0]!)).not.toContain("first task");

  // The changing task list rode in each turn's newest user message instead,
  // with positional t<N> ids for id-addressed update_tasks patches.
  const lastUser = (p: { role: string; content: unknown }[]) => {
    const us = p.filter((m) => m.role === "user");
    return JSON.stringify(us[us.length - 1]?.content);
  };
  expect(lastUser(prompts[0]!)).toContain("t1 [~] first task");
  expect(lastUser(prompts[1]!)).toContain("t1 [x] first task");
  expect(lastUser(prompts[1]!)).toContain("t2 [~] second task");
});

test("exactly one conversation cache breakpoint rides the trailing message (plus the system one)", async () => {
  let captured: { role: string; providerOptions?: unknown }[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (opts: { prompt?: unknown[] }) => {
      captured = (opts.prompt ?? []) as { role: string; providerOptions?: unknown }[];
      return reply() as never;
    },
  });
  const session = new Session({
    config: defaultConfig(),
    registry: anthropicRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "anthropic/claude-test",
    mode: "execute",
  });

  await session.run("hello");

  // The system message carries its own breakpoint; among the NON-system messages
  // exactly one — the last — carries the conversation breakpoint. Never more (the
  // 4-breakpoint cap) and never zero (else the tail re-bills every step).
  const nonSystem = captured.filter((m) => m.role !== "system");
  const marked = nonSystem.filter(hasCacheMarker);
  expect(marked).toHaveLength(1);
  expect(hasCacheMarker(nonSystem[nonSystem.length - 1])).toBe(true);
});
