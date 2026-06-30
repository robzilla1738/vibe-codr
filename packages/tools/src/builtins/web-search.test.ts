import { test, expect, afterEach } from "bun:test";
import type { ToolContext } from "@vibe/shared";
import { webSearchTool, formatResults } from "./web-search.ts";
import type { FetchLike } from "./search-engines.ts";

function ctx(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: "s",
    emit: () => {},
    toolCallId: "t",
    abortSignal: new AbortController().signal,
  };
}

const realKey = process.env.TINYFISH_API_KEY;
afterEach(() => {
  if (realKey === undefined) delete process.env.TINYFISH_API_KEY;
  else process.env.TINYFISH_API_KEY = realKey;
});

/** A DuckDuckGo HTML results fixture (two results). */
const DDG_HTML = `
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs&amp;rut=x">Bun <b>docs</b></a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh">The fast all-in-one runtime &amp; toolkit.</a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">Example</a>
  </h2>
  <a class="result__snippet">Second snippet.</a>
</div>`;

/** A fetchImpl that routes by URL and records what it saw. */
function routingFetch(opts: {
  ddg?: { body: string; status?: number };
  tinyfish?: { body: string; status?: number };
}): { fetch: FetchLike; seen: { url: string; key: string } } {
  const seen = { url: "", key: "" };
  const fetch: FetchLike = async (url, init) => {
    seen.url = url;
    seen.key = init?.headers?.["X-API-Key"] ?? seen.key;
    const which = url.includes("duckduckgo") ? opts.ddg : opts.tinyfish;
    const status = which?.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => which?.body ?? "" };
  };
  return { fetch, seen };
}

test("works keyless via DuckDuckGo (no API key required)", async () => {
  delete process.env.TINYFISH_API_KEY;
  const { fetch, seen } = routingFetch({ ddg: { body: DDG_HTML } });
  const res = await webSearchTool({ fetchImpl: fetch }).execute({ query: "bun docs" }, ctx());
  expect(res.isError).toBeUndefined();
  const out = String(res.output);
  expect(out).toContain("Bun docs");
  expect(out).toContain("https://bun.sh/docs"); // uddg redirect decoded
  expect(out).toContain("The fast all-in-one runtime & toolkit."); // entities decoded
  expect(seen.url).toContain("html.duckduckgo.com");
});

test("uses TinyFish first when a key is set, sending the X-API-Key header", async () => {
  delete process.env.TINYFISH_API_KEY;
  const tf = JSON.stringify({
    results: [{ position: 1, site_name: "Bun", title: "Bun homepage", snippet: "x", url: "https://bun.sh" }],
  });
  const { fetch, seen } = routingFetch({ tinyfish: { body: tf } });
  const res = await webSearchTool({ apiKey: "secret-key", fetchImpl: fetch }).execute(
    { query: "bun test", recencyDays: 7 },
    ctx(),
  );
  expect(seen.url).toContain("recency_minutes=10080"); // 7*24*60
  expect(seen.key).toBe("secret-key");
  expect(String(res.output)).toContain("Bun homepage");
});

test("falls back to DuckDuckGo when TinyFish fails (auth error)", async () => {
  process.env.TINYFISH_API_KEY = "bad";
  const { fetch } = routingFetch({
    tinyfish: { body: "nope", status: 401 },
    ddg: { body: DDG_HTML },
  });
  const res = await webSearchTool({ fetchImpl: fetch }).execute({ query: "bun docs" }, ctx());
  // TinyFish 401 → fall through to the keyless engine, which succeeds.
  expect(res.isError).toBeUndefined();
  expect(String(res.output)).toContain("Bun docs");
});

test("maxResults trims the result list", async () => {
  delete process.env.TINYFISH_API_KEY;
  const { fetch } = routingFetch({ ddg: { body: DDG_HTML } });
  const res = await webSearchTool({ fetchImpl: fetch }).execute({ query: "x", maxResults: 1 }, ctx());
  expect(String(res.output)).toContain("Bun docs");
  expect(String(res.output)).not.toContain("Example");
});

test("reports an error only when every engine fails", async () => {
  delete process.env.TINYFISH_API_KEY;
  const { fetch } = routingFetch({ ddg: { body: "boom", status: 503 } });
  const res = await webSearchTool({ fetchImpl: fetch }).execute({ query: "x" }, ctx());
  expect(res.isError).toBe(true);
  expect(String(res.output)).toMatch(/duckduckgo/i);
});

test("formatResults numbers results and collapses snippet whitespace", () => {
  const out = formatResults("q", [
    { position: 1, site_name: "S", title: "T", snippet: "a   b\n c", url: "u" },
  ]);
  expect(out).toContain("1. T");
  expect(out).toContain("a b c");
});
