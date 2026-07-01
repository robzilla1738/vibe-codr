import { test, expect } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";
import { composeSystemPrompt } from "./system-prompt.ts";
import { handleSlash, type EngineHandle } from "./engine-commands.ts";
import { SourceLedger, canonicalizeUrl, harvestUrls } from "./source-ledger.ts";

// ── canonicalizeUrl ────────────────────────────────────────────────────────

test("canonicalizeUrl strips tracking params, www, trailing slash, fragment; sorts query", () => {
  expect(canonicalizeUrl("https://www.Example.com/Docs/?utm_source=x&b=2&a=1#frag")).toBe(
    "https://example.com/Docs?a=1&b=2",
  );
  // Two spellings of the same page collapse to one key.
  expect(canonicalizeUrl("https://example.com/docs/?fbclid=abc")).toBe(
    canonicalizeUrl("https://example.com/docs"),
  );
  // A non-URL degrades to a lower-cased passthrough (never throws).
  expect(canonicalizeUrl("not a url")).toBe("not a url");
});

// ── SourceLedger.record / list / indices / dedupe ──────────────────────────

test("record assigns stable [n] indices in first-seen order and dedupes by canonical URL", () => {
  const led = new SourceLedger();
  const a = led.record({ url: "https://foo.com/a", via: "web_search" });
  const b = led.record({ url: "https://bar.com/b", via: "webfetch" });
  // A tracking-param variant of the first URL dedupes — same index, no new entry.
  const aAgain = led.record({ url: "https://www.foo.com/a/?utm_source=nl", via: "webfetch" });

  expect(a?.index).toBe(1);
  expect(b?.index).toBe(2);
  expect(aAgain?.index).toBe(1);
  expect(led.size).toBe(2);
  expect(led.list().map((e) => e.index)).toEqual([1, 2]);
  expect(led.list().map((e) => e.url)).toEqual(["https://foo.com/a", "https://bar.com/b"]);
});

test("record back-fills a title on a later sighting and ignores empty urls", () => {
  const led = new SourceLedger();
  led.record({ url: "https://foo.com/a", via: "web_search" });
  led.record({ url: "https://foo.com/a", via: "webfetch", title: "The A Page" });
  expect(led.list()[0]?.title).toBe("The A Page");

  expect(led.record({ url: "   ", via: "web_search" })).toBeUndefined();
  expect(led.size).toBe(1);
});

test("the ledger is bounded: beyond the cap the oldest drop (indices stay stable) with a note", () => {
  const led = new SourceLedger(3);
  for (let i = 1; i <= 5; i++) led.record({ url: `https://ex.com/${i}`, via: "web_search" });
  // Only the 3 newest survive; their original indices are preserved.
  expect(led.size).toBe(3);
  expect(led.list().map((e) => e.index)).toEqual([3, 4, 5]);
  const out = led.format();
  expect(out).toContain("[3] https://ex.com/3");
  expect(out).not.toContain("[1] ");
  expect(out).toContain("2 older sources dropped");
});

// ── SourceLedger.format bounding ───────────────────────────────────────────

test("format renders a numbered list and is empty for an empty ledger", () => {
  expect(new SourceLedger().format()).toBe("");
  const led = new SourceLedger();
  led.record({ url: "https://foo.com/a", via: "web_search", title: "A" });
  expect(led.format()).toBe("[1] https://foo.com/a — A");
});

test("format bounds to ~maxChars, keeping the most-recent entries with a truncation marker", () => {
  const led = new SourceLedger();
  for (let i = 1; i <= 40; i++) {
    led.record({ url: `https://example.com/very/long/path/segment/number/${i}`, via: "web_search" });
  }
  const out = led.format(400);
  expect(out.length).toBeLessThanOrEqual(400);
  expect(out).toContain("earlier sources omitted");
  // Most-recent-first selection: the last entry survives, an early one doesn't.
  expect(out).toContain("[40] ");
  expect(out).not.toContain("[1] ");
});

// ── harvestUrls ────────────────────────────────────────────────────────────

test("harvestUrls extracts http(s) URLs from formatted search output and strips trailing punctuation", () => {
  const text =
    'Search results for "x"\n\n' +
    "1. Foo\n   https://foo.example.com/a\n   A snippet.\n\n" +
    "2. Bar (see https://bar.example.com/b), and end https://baz.example.com/c.";
  expect(harvestUrls(text)).toEqual([
    "https://foo.example.com/a",
    "https://bar.example.com/b",
    "https://baz.example.com/c",
  ]);
});

test("harvestUrls dedupes exact repeats, caps at max, and keeps balanced parens", () => {
  const text =
    "https://a.com https://a.com https://b.com https://c.com " +
    "https://en.wikipedia.org/wiki/Foo_(bar)";
  expect(harvestUrls(text, 2)).toEqual(["https://a.com", "https://b.com"]);
  // A closing paren with a matching opener inside the URL is preserved.
  expect(harvestUrls("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
    "https://en.wikipedia.org/wiki/Foo_(bar)",
  ]);
});

// ── composeSystemPrompt sources block ──────────────────────────────────────

test("composeSystemPrompt injects the SOURCES GATHERED block only when sources are present", () => {
  const withSrc = composeSystemPrompt({
    mode: "execute",
    goal: null,
    sources: "[1] https://foo.com/a — Foo\n[2] https://bar.com/b",
  });
  expect(withSrc).toContain("SOURCES GATHERED THIS SESSION");
  expect(withSrc).toContain("[1] https://foo.com/a — Foo");
  // The always-on citation instruction lives in the base web-context block.
  expect(withSrc).toMatch(/CITE YOUR SOURCES/);
  expect(composeSystemPrompt({ mode: "execute", goal: null })).not.toContain(
    "SOURCES GATHERED THIS SESSION",
  );
});

// ── session integration ────────────────────────────────────────────────────

function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({
      chunks: chunks as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function mockRegistry(model: MockLanguageModelV2): ProviderRegistry {
  return new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
}

test("session harvests URLs from a web_search result and injects them into the next turn's prompt", async () => {
  const webSearch: ToolDefinition<{ query: string }> = {
    name: "web_search",
    description: "Fake web search.",
    inputSchema: z.object({ query: z.string() }),
    readOnly: true,
    network: true,
    async execute() {
      return {
        output:
          'Search results for "x"\n\n' +
          "1. Foo\n   https://foo.example.com/a\n   A snippet.\n\n" +
          "2. Bar\n   https://bar.example.com/b.\n   Another snippet.",
      };
    },
  };

  const steps = [
    // Turn 1: model calls web_search…
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "web_search", input: JSON.stringify({ query: "x" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    // …then answers.
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "done" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
    // Turn 2: plain answer — we capture its prompt.
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "follow up" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  let lastPrompt: { role: string; content: unknown }[] = [];
  const model = new MockLanguageModelV2({
    doStream: async (opts: { prompt?: unknown[] }) => {
      lastPrompt = (opts.prompt ?? []) as { role: string; content: unknown }[];
      return steps[call++] as never;
    },
  });

  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([webSearch]),
    bus: new EventBus(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  await session.run("search please");
  // Both URLs harvested and deduped/numbered on the ledger.
  expect(session.sources.size).toBe(2);
  expect(session.sources.list().map((e) => e.url)).toEqual([
    "https://foo.example.com/a",
    "https://bar.example.com/b",
  ]);

  await session.run("follow up");
  const sys = lastPrompt.find((m) => m.role === "system");
  const sysText = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content);
  expect(sysText).toContain("SOURCES GATHERED THIS SESSION");
  expect(sysText).toContain("[1] https://foo.example.com/a");
  expect(sysText).toContain("[2] https://bar.example.com/b");
});

// ── /sources command ───────────────────────────────────────────────────────

function stubHandle(ledger: SourceLedger, notices: string[]): EngineHandle {
  return {
    commands: { get: () => undefined },
    session: { sources: ledger },
    notice: (message: string) => notices.push(message),
  } as unknown as EngineHandle;
}

test("/sources prints the session's gathered sources with their [n] indices", async () => {
  const ledger = new SourceLedger();
  ledger.record({ url: "https://a.example.com/x", via: "web_search", title: "Page A" });
  ledger.record({ url: "https://b.example.com/y", via: "webfetch" });
  const notices: string[] = [];
  await handleSlash(stubHandle(ledger, notices), "sources", "");
  const out = notices.join("\n");
  expect(out).toContain("[1] https://a.example.com/x — Page A");
  expect(out).toContain("[2] https://b.example.com/y");
});

test("/sources reports an empty ledger honestly", async () => {
  const notices: string[] = [];
  await handleSlash(stubHandle(new SourceLedger(), notices), "sources", "");
  expect(notices.join("\n")).toContain("No web sources gathered");
});
