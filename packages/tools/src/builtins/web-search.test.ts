import { test, expect, afterEach } from "bun:test";
import type { ToolContext } from "@vibe/shared";
import { webSearchTool, formatResults } from "./web-search.ts";

function ctx(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: "s",
    emit: () => {},
    toolCallId: "t",
    abortSignal: new AbortController().signal,
  };
}

const realFetch = globalThis.fetch;
const realKey = process.env.TINYFISH_API_KEY;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.TINYFISH_API_KEY;
  else process.env.TINYFISH_API_KEY = realKey;
});

test("errors with guidance when no API key is configured", async () => {
  delete process.env.TINYFISH_API_KEY;
  const res = await webSearchTool().execute({ query: "anything" }, ctx());
  expect(res.isError).toBe(true);
  expect(String(res.output)).toContain("TinyFish");
});

/** Install a fake `fetch` that records the request and returns `body`. */
function stubFetch(body: unknown, status = 200): { url: string; key: string } {
  const seen = { url: "", key: "" };
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    seen.url = String(input);
    seen.key = init?.headers?.["X-API-Key"] ?? "";
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return seen;
}

test("sends the query + X-API-Key header and formats results", async () => {
  delete process.env.TINYFISH_API_KEY;
  const seen = stubFetch({
    query: "bun test",
    results: [
      { position: 1, site_name: "Bun", title: "Bun docs", snippet: "fast  runtime", url: "https://bun.sh" },
    ],
    total_results: 1,
    page: 0,
  });

  const res = await webSearchTool({ apiKey: "secret-key" }).execute(
    { query: "bun test", recencyDays: 7 },
    ctx(),
  );

  expect(seen.url).toContain("query=bun+test");
  expect(seen.url).toContain("recency_minutes=10080"); // 7 * 24 * 60
  expect(seen.key).toBe("secret-key");
  expect(res.isError).toBeUndefined();
  expect(String(res.output)).toContain("Bun docs");
  expect(String(res.output)).toContain("https://bun.sh");
});

test("keeps every provider result by default; maxResults only trims", async () => {
  process.env.TINYFISH_API_KEY = "k";
  const many = Array.from({ length: 12 }, (_, i) => ({
    position: i + 1,
    site_name: "S",
    title: `Result ${i + 1}`,
    snippet: "s",
    url: `https://x/${i + 1}`,
  }));
  // Default: no engine throttle — all 12 provider results are kept.
  stubFetch({ results: many });
  const all = await webSearchTool().execute({ query: "deep research" }, ctx());
  expect(String(all.output)).toContain("Result 12");
  // Quick fact: trim to the top 3.
  stubFetch({ results: many });
  const tight = await webSearchTool().execute({ query: "btc price", maxResults: 3 }, ctx());
  expect(String(tight.output)).toContain("Result 3");
  expect(String(tight.output)).not.toContain("Result 4");
});

test("env var takes precedence over the configured key", async () => {
  process.env.TINYFISH_API_KEY = "env-key";
  const seen = stubFetch({ results: [] });
  await webSearchTool({ apiKey: "config-key" }).execute({ query: "x" }, ctx());
  expect(seen.key).toBe("env-key");
});

test("surfaces an auth hint on 401", async () => {
  process.env.TINYFISH_API_KEY = "bad";
  stubFetch("nope", 401);
  const res = await webSearchTool().execute({ query: "x" }, ctx());
  expect(res.isError).toBe(true);
  expect(String(res.output)).toContain("API key");
});

test("formatResults numbers results and collapses snippet whitespace", () => {
  const out = formatResults("q", [
    { position: 1, site_name: "S", title: "T", snippet: "a   b\n c", url: "u" },
  ]);
  expect(out).toContain("1. T");
  expect(out).toContain("a b c");
});
