import { test, expect } from "bun:test";
import {
  parseDuckDuckGoHtml,
  duckDuckGoSearch,
  parseBingHtml,
  bingSearch,
  createCooldown,
} from "./search-engines.ts";

const HTML = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=z">First &amp; Title</a>
<a class="result__snippet">Snippet <b>one</b> here.</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Second</a>
<a class="result__snippet">Snippet two.</a>`;

test("parseDuckDuckGoHtml decodes redirect URLs, entities, and pairs snippets", () => {
  const results = parseDuckDuckGoHtml(HTML);
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({
    position: 1,
    title: "First & Title",
    url: "https://example.com/a",
    site_name: "example.com",
    snippet: "Snippet one here.",
  });
  expect(results[1]!.url).toBe("https://example.org/b");
  expect(results[1]!.snippet).toBe("Snippet two.");
});

test("parseDuckDuckGoHtml returns [] for a page with no results", () => {
  expect(parseDuckDuckGoHtml("<html><body>no results</body></html>")).toEqual([]);
});

test("parseDuckDuckGoHtml keeps snippets aligned when a malformed result is skipped", () => {
  const html = `
<a class="result__a" href="/not-a-real-destination">Bad row</a>
<a class="result__snippet">Snippet for bad row.</a>
<a class="result__a" href="https://example.com/good">Good row</a>
<a class="result__snippet">Snippet for good row.</a>`;
  const results = parseDuckDuckGoHtml(html);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    position: 2,
    url: "https://example.com/good",
    snippet: "Snippet for good row.",
  });
});

test("parseDuckDuckGoHtml is LINEAR on unclosed anchors (adversarial P7-W1)", () => {
  // The snippet/link captures used a lazy `[\s\S]*?</a>` that re-scans to EOF per
  // unclosed `<a …>` opener → O(n²); the keyless-search fetch reads res.text()
  // UNCAPPED and parses synchronously, so an oversized/garbled results page froze
  // web_search (~4.5s at 720KB). The unrolled `(?:[^<]|<(?!/a[\s>]))*` is linear.
  const evil = `${`<a class="result__snippet" href="/x">`.repeat(16000)}tail`; // ~0.7MB
  const t0 = performance.now();
  const out = parseDuckDuckGoHtml(evil);
  expect(performance.now() - t0).toBeLessThan(1000); // was ~4500ms
  expect(Array.isArray(out)).toBe(true);
});

test("duckDuckGoSearch fetches the html endpoint and applies maxResults", async () => {
  let calledUrl = "";
  const result = await duckDuckGoSearch(
    "bun runtime",
    { maxResults: 1, recencyDays: 7 },
    async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, text: async () => HTML };
    },
  );
  expect(calledUrl).toContain("html.duckduckgo.com");
  expect(calledUrl).toContain("df=w"); // 7 days → week
  expect(result).toHaveLength(1);
});

test("duckDuckGoSearch throws on a non-OK response", async () => {
  await expect(
    duckDuckGoSearch("x", {}, async () => ({ ok: false, status: 429, text: async () => "" })),
  ).rejects.toThrow(/429/);
});

const BING_HTML = `
<ol id="b_results">
  <li class="b_algo"><h2><a href="https://example.com/a">First &amp; Title</a></h2><p>Bing <strong>snippet</strong> one.</p></li>
  <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;u=a1aHR0cHM6Ly9leGFtcGxlLm9yZy9i&amp;ntb=1">Second</a></h2><p>Snippet two.</p></li>
</ol>`;

test("parseBingHtml extracts links, decodes entities, and unwraps /ck/ redirects", () => {
  const results = parseBingHtml(BING_HTML);
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({
    position: 1,
    title: "First & Title",
    url: "https://example.com/a",
    site_name: "example.com",
    snippet: "Bing snippet one.",
  });
  // The second URL is base64url-encoded inside Bing's /ck/ redirect.
  expect(results[1]!.url).toBe("https://example.org/b");
});

test("parseBingHtml returns [] for a page with no results", () => {
  expect(parseBingHtml("<html><body>no results</body></html>")).toEqual([]);
});

test("parseBingHtml is LINEAR on an unbounded single block (adversarial P8)", () => {
  // A page with no `b_algo` split point becomes ONE giant block; the per-block
  // `<h2>…<a>([\s\S]*?)</a>` / `<p>([\s\S]*?)</p>` `.exec` then retries at every
  // `<h2>` when the close is missing → O(n²) (~6.7s at 720KB). Unrolled bodies
  // match on the first attempt.
  const evil = `<li class="b_algo"><h2><a href="x">${`<h2><a href="x">`.repeat(32000)}tail`;
  const t0 = performance.now();
  const out = parseBingHtml(evil);
  expect(performance.now() - t0).toBeLessThan(1000); // was ~6700ms
  expect(Array.isArray(out)).toBe(true);
});

test("bingSearch fetches the search endpoint, applies recency + maxResults", async () => {
  let calledUrl = "";
  const result = await bingSearch(
    "bun runtime",
    { maxResults: 1, recencyDays: 7 },
    async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, text: async () => BING_HTML };
    },
  );
  expect(calledUrl).toContain("bing.com/search");
  expect(decodeURIComponent(calledUrl)).toContain('ex1:"ez2"'); // 7 days → week
  expect(result).toHaveLength(1);
});

test("bingSearch throws on a non-OK response", async () => {
  await expect(
    bingSearch("x", {}, async () => ({ ok: false, status: 403, text: async () => "" })),
  ).rejects.toThrow(/403/);
});

test("cooldown blocks a tripped engine within its window", () => {
  const cd = createCooldown(1_000);
  expect(cd.blocked("ddg", 0)).toBe(false);
  cd.trip("ddg", 0);
  expect(cd.blocked("ddg", 500)).toBe(true); // within window
  expect(cd.blocked("ddg", 1_500)).toBe(false); // window elapsed
});
