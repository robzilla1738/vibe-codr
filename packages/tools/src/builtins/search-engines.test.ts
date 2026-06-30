import { test, expect } from "bun:test";
import { parseDuckDuckGoHtml, duckDuckGoSearch, createCooldown } from "./search-engines.ts";

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

test("cooldown blocks a tripped engine within its window", () => {
  const cd = createCooldown(1_000);
  expect(cd.blocked("ddg", 0)).toBe(false);
  cd.trip("ddg", 0);
  expect(cd.blocked("ddg", 500)).toBe(true); // within window
  expect(cd.blocked("ddg", 1_500)).toBe(false); // window elapsed
});
