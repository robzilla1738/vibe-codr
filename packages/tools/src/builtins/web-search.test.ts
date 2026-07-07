import { test, expect, afterEach, beforeEach } from "bun:test";
import type { ToolContext } from "@vibe/shared";
import { webSearchTool, formatResults, _resetSearchCooldown } from "./web-search.ts";
import type { FetchLike } from "./search-engines.ts";

// The engine cooldown is a module-level singleton; reset it between tests so a
// 429/503 tripped in one test can't block engines in the next.
beforeEach(() => _resetSearchCooldown());

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

/** A Bing HTML results fixture: one URL that duplicates DDG's (to prove dedup)
 * plus one unique URL. */
const BING_HTML = `
<ol id="b_results">
  <li class="b_algo"><h2><a href="https://bun.sh/docs">Bun Docs on Bing</a></h2><p>Bing's snippet.</p></li>
  <li class="b_algo"><h2><a href="https://bun.sh/blog">Bun Blog</a></h2><p>Release notes.</p></li>
</ol>`;

/** A fetchImpl that routes by host and records every URL/key it saw. */
function routingFetch(opts: {
  ddg?: { body: string; status?: number };
  bing?: { body: string; status?: number };
  tinyfish?: { body: string; status?: number };
}): { fetch: FetchLike; seen: { urls: string[]; key: string } } {
  const seen = { urls: [] as string[], key: "" };
  const fetch: FetchLike = async (url, init) => {
    seen.urls.push(url);
    seen.key = init?.headers?.["X-API-Key"] ?? seen.key;
    const which = url.includes("duckduckgo")
      ? opts.ddg
      : url.includes("bing.com")
        ? opts.bing
        : opts.tinyfish;
    const status = which?.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => which?.body ?? "" };
  };
  return { fetch, seen };
}

test("works keyless, fanning out across DuckDuckGo and Bing (no API key required)", async () => {
  delete process.env.TINYFISH_API_KEY;
  const { fetch, seen } = routingFetch({ ddg: { body: DDG_HTML }, bing: { body: BING_HTML } });
  const res = await webSearchTool({ fetchImpl: fetch }).execute({ query: "bun docs" }, ctx());
  expect(res.isError).toBeUndefined();
  const out = String(res.output);
  expect(out).toContain("https://bun.sh/docs"); // uddg redirect decoded
  expect(out).toContain("The fast all-in-one runtime & toolkit."); // entities decoded
  expect(out).toContain("https://bun.sh/blog"); // Bing-only result merged in
  // Both keyless engines were queried.
  expect(seen.urls.some((u) => u.includes("html.duckduckgo.com"))).toBe(true);
  expect(seen.urls.some((u) => u.includes("bing.com"))).toBe(true);
});

test("dedupes by canonical URL across engines (one bun.sh/docs, not two)", async () => {
  delete process.env.TINYFISH_API_KEY;
  const { fetch } = routingFetch({ ddg: { body: DDG_HTML }, bing: { body: BING_HTML } });
  const out = String((await webSearchTool({ fetchImpl: fetch }).execute({ query: "bun" }, ctx())).output);
  // bun.sh/docs appears in BOTH engines' results but is merged to a single entry.
  expect(out.split("https://bun.sh/docs").length - 1).toBe(1);
});

test("uses TinyFish when a key is set, sending the X-API-Key header + recency", async () => {
  delete process.env.TINYFISH_API_KEY;
  const tf = JSON.stringify({
    results: [{ position: 1, site_name: "Bun", title: "Bun homepage", snippet: "x", url: "https://bun.sh" }],
  });
  const { fetch, seen } = routingFetch({ tinyfish: { body: tf }, ddg: { body: "" }, bing: { body: "" } });
  const res = await webSearchTool({ apiKey: "secret-key", fetchImpl: fetch }).execute(
    { query: "bun test", recencyDays: 7 },
    ctx(),
  );
  expect(seen.urls.some((u) => u.includes("recency_minutes=10080"))).toBe(true); // 7*24*60
  expect(seen.key).toBe("secret-key");
  expect(String(res.output)).toContain("Bun homepage");
});

test("a failed engine doesn't sink the batch (TinyFish 401 → keyless results win)", async () => {
  process.env.TINYFISH_API_KEY = "bad";
  const { fetch } = routingFetch({
    tinyfish: { body: "nope", status: 401 },
    ddg: { body: DDG_HTML },
    bing: { body: "" },
  });
  const res = await webSearchTool({ fetchImpl: fetch }).execute({ query: "bun docs" }, ctx());
  expect(res.isError).toBeUndefined();
  expect(String(res.output)).toContain("https://bun.sh/docs");
});

test("a malformed TinyFish 200 (non-array results) doesn't sink the batch (adversarial P5-W1)", async () => {
  // An error-envelope 200 like `{"results":{"error":"quota exceeded"}}` used to
  // reach `collect()`'s `s.results.entries()` and THROW, converting a successful
  // keyless fan-out into a hard `web_search` error. A truthy non-array must be
  // treated as "no results from this engine", not a crash.
  for (const body of ['{"results":{"error":"quota exceeded"}}', '{"results":"rate limited"}', "{}"]) {
    process.env.TINYFISH_API_KEY = "set";
    const { fetch } = routingFetch({ tinyfish: { body }, ddg: { body: DDG_HTML }, bing: { body: "" } });
    const res = await webSearchTool({ apiKey: "set", fetchImpl: fetch }).execute({ query: "bun docs" }, ctx());
    expect([body, res.isError]).toEqual([body, undefined]);
    expect(String(res.output)).toContain("https://bun.sh/docs"); // DDG results still win
  }
  delete process.env.TINYFISH_API_KEY;
});

test("a malformed TinyFish ELEMENT (missing snippet/url) doesn't sink the batch (adversarial P6-1)", async () => {
  // The container guard (P5-W1) isn't enough: a well-formed array whose ENTRIES omit
  // `snippet`/`url` still threw in collect() (detectDate(undefined) / canonicalizeUrl(undefined)),
  // sinking the whole tool. Entries are now coerced to strings and url-less ones dropped.
  const bodies = [
    '{"results":[{"title":"T","url":"https://ex.com/a"}]}', // no snippet
    '{"results":[{"title":"T","snippet":"s"}]}', // no url → dropped
    '{"results":[{"position":"x","site_name":null,"title":42,"snippet":{},"url":"https://ex.com/b"}]}', // wrong types
  ];
  for (const body of bodies) {
    process.env.TINYFISH_API_KEY = "set";
    const { fetch } = routingFetch({ tinyfish: { body }, ddg: { body: DDG_HTML }, bing: { body: "" } });
    const res = await webSearchTool({ apiKey: "set", fetchImpl: fetch }).execute({ query: "bun docs" }, ctx());
    expect([body, res.isError]).toEqual([body, undefined]);
    expect(String(res.output)).toContain("https://bun.sh/docs"); // keyless results still win
  }
  delete process.env.TINYFISH_API_KEY;
});

test("maxResults trims the merged, ranked list", async () => {
  delete process.env.TINYFISH_API_KEY;
  const { fetch } = routingFetch({ ddg: { body: DDG_HTML }, bing: { body: "" } });
  const res = await webSearchTool({ fetchImpl: fetch }).execute({ query: "x", maxResults: 1 }, ctx());
  const out = String(res.output);
  // The docs page ranks above the bare "Example" result and is the only one kept.
  expect(out).toContain("https://bun.sh/docs");
  expect(out).not.toContain("example.com/x");
});

test("reports an error only when every engine fails", async () => {
  delete process.env.TINYFISH_API_KEY;
  const { fetch } = routingFetch({ ddg: { body: "boom", status: 503 }, bing: { body: "boom", status: 503 } });
  const res = await webSearchTool({ fetchImpl: fetch }).execute({ query: "x" }, ctx());
  expect(res.isError).toBe(true);
  expect(String(res.output)).toMatch(/duckduckgo|bing/i);
});

test("reports a cooldown error when every engine is temporarily skipped", async () => {
  delete process.env.TINYFISH_API_KEY;
  const failing = routingFetch({ ddg: { body: "boom", status: 503 }, bing: { body: "boom", status: 503 } });
  const first = await webSearchTool({ fetchImpl: failing.fetch }).execute({ query: "x" }, ctx());
  expect(first.isError).toBe(true);

  const healthy = routingFetch({ ddg: { body: DDG_HTML }, bing: { body: BING_HTML } });
  const second = await webSearchTool({ fetchImpl: healthy.fetch }).execute({ query: "x" }, ctx());
  expect(second.isError).toBe(true);
  expect(String(second.output)).toContain("temporarily cooling down");
  expect(String(second.output)).not.toContain("No results");
  expect(healthy.seen.urls).toEqual([]);
});

test("deep mode fans the query into multiple phrasings (more engine calls)", async () => {
  delete process.env.TINYFISH_API_KEY;
  const shallow = routingFetch({ ddg: { body: DDG_HTML }, bing: { body: "" } });
  await webSearchTool({ fetchImpl: shallow.fetch }).execute({ query: "how do I use bun test" }, ctx());
  const deep = routingFetch({ ddg: { body: DDG_HTML }, bing: { body: "" } });
  // Inject `enrichFetch` (as the sibling deep tests do) so deep mode's top-page
  // enrichment hits the stub, not real bun.sh/example.com over the network — the
  // uncontrolled egress that made this test intermittently exceed Bun's 5s timeout.
  await webSearchTool({
    fetchImpl: deep.fetch,
    enrichFetch: async () => "Enriched page body for the deep-mode fan-out test.",
  }).execute({ query: "how do I use bun test", deep: true }, ctx());
  // A question-shaped query expands to several phrasings → strictly more calls.
  expect(deep.seen.urls.length).toBeGreaterThan(shallow.seen.urls.length);
});

test("formatResults numbers results and collapses snippet whitespace", () => {
  const out = formatResults("q", [
    { title: "T", snippet: "a   b\n c", url: "u" },
  ]);
  expect(out).toContain("1. T");
  expect(out).toContain("a b c");
});

// ---------------------------------------------------------------- research-grade search

test("zero results retries once with the reformulated keyword core, annotated", async () => {
  _resetSearchCooldown();
  const queries: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    const q = new URL(String(url)).searchParams.get("q") ?? "";
    queries.push(q);
    // The over-constrained quoted query gets nothing; the keyword core hits.
    const hit = !q.includes('"');
    const html = hit
      ? `<a class="result__a" href="https://docs.example.com/x">Doc</a><a class="result__snippet">the answer lives here</a>`
      : "<html>no results</html>";
    return new Response(html, { headers: { "content-type": "text/html" } });
  };
  const res = await webSearchTool({ fetchImpl }).execute(
    { query: '"impossibly overconstrained exotic phrasing" site:nowhere.invalid' },
    ctx(),
  );
  const out = String(res.output);
  expect(out).toContain("reformulated to");
  expect(out).toContain("docs.example.com");
  // The second wave actually used the keyword core (operators stripped).
  expect(queries.some((q) => !q.includes("site:") && !q.includes('"'))).toBe(true);
});

test("deep mode fetches top pages and returns dated, quotable passages", async () => {
  _resetSearchCooldown();
  const fetchImpl: FetchLike = async () => {
    const html =
      `<a class="result__a" href="https://blog.example.com/release">Release notes</a>` +
      `<a class="result__snippet">version news</a>`;
    return new Response(html, { headers: { "content-type": "text/html" } });
  };
  const res = await webSearchTool({
    fetchImpl,
    enrichFetch: async () =>
      "Published 2025-11-02. The framework version 9 release introduces the new compiler. " +
      "Migration from version 8 requires the codemod. ".repeat(10),
  }).execute({ query: "framework version 9 release compiler", deep: true }, ctx());
  const out = String(res.output);
  expect(out).toContain("Deep search results");
  expect(out).toContain("> "); // quoted passages present
  expect(out).toContain("version 9 release");
  expect(out).toContain("(2025-11-02)"); // date detected from page content
});

test("a dead page in deep mode degrades to its snippet instead of failing the search", async () => {
  _resetSearchCooldown();
  const fetchImpl: FetchLike = async () => {
    const html =
      `<a class="result__a" href="https://dead.example.com/gone">Dead page</a>` +
      `<a class="result__snippet">still-useful snippet</a>`;
    return new Response(html, { headers: { "content-type": "text/html" } });
  };
  const res = await webSearchTool({
    fetchImpl,
    enrichFetch: async () => {
      throw new Error("HTTP 404");
    },
  }).execute({ query: "anything", deep: true }, ctx());
  expect(res.isError).toBeUndefined();
  expect(String(res.output)).toContain("still-useful snippet");
});
