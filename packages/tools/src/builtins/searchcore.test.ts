import { test, expect } from "bun:test";
import {
  canonicalizeUrl,
  classifySource,
  mergeCandidates,
  resultQualityScore,
  selectPassages,
  queryTerms,
  expandQueries,
  detectDate,
  freshnessBoost,
  scorePage,
  type Candidate,
} from "./searchcore.ts";

test("canonicalizeUrl strips tracking params, www, and trailing slash; sorts query", () => {
  expect(canonicalizeUrl("https://www.Example.com/Docs/?utm_source=x&b=2&a=1")).toBe(
    "https://example.com/Docs?a=1&b=2",
  );
  // Same page, different tracking noise → identical canonical form (dedup key).
  expect(canonicalizeUrl("https://example.com/docs/?fbclid=abc")).toBe(
    canonicalizeUrl("https://example.com/docs"),
  );
  // Invalid URL falls back to a lowercased string.
  expect(canonicalizeUrl("not a url")).toBe("not a url");
});

test("classifySource recognizes primary/gov/academic/social/news vs secondary", () => {
  expect(classifySource("who.int")).toBe("primary");
  expect(classifySource("data.europa.eu")).toBe("primary");
  expect(classifySource("nasa.gov")).toBe("government");
  expect(classifySource("mit.edu")).toBe("academic");
  expect(classifySource("arxiv.org")).toBe("academic");
  expect(classifySource("reddit.com")).toBe("social");
  expect(classifySource("bbc.co.uk")).toBe("news");
  expect(classifySource("some-blog.dev")).toBe("secondary");
});

test("mergeCandidates dedupes by canonical URL and ranks quality-first", () => {
  const cands: Candidate[] = [
    { title: "Noise", url: "https://blog.example.com/x", snippet: "", rank: 1, engine: "ddg" },
    { title: "Docs", url: "https://bun.sh/docs", snippet: "", rank: 3, engine: "ddg" },
    // duplicate of the docs page via a different engine + tracking param
    { title: "Docs (bing)", url: "https://bun.sh/docs?utm_source=bing", snippet: "", rank: 1, engine: "bing" },
  ];
  const merged = mergeCandidates(cands, 10);
  // Three inputs collapse to two unique URLs.
  expect(merged.length).toBe(2);
  expect(merged.filter((c) => c.url.includes("bun.sh/docs")).length).toBe(1);
  // The docs page (url contains "docs" → quality boost) ranks first.
  expect(merged[0]!.url).toContain("bun.sh/docs");
});

test("mergeCandidates caps at maxResults", () => {
  const cands: Candidate[] = Array.from({ length: 5 }, (_, i) => ({
    title: `T${i}`,
    url: `https://s${i}.com/`,
    snippet: "",
    rank: i + 1,
    engine: "ddg",
  }));
  expect(mergeCandidates(cands, 2).length).toBe(2);
});

test("resultQualityScore boosts official/docs/github and penalizes low-value snippets", () => {
  const base: Candidate = { title: "t", url: "https://x.com/y", snippet: "", rank: 1, engine: "ddg" };
  expect(resultQualityScore({ ...base, url: "https://x.com/docs" })).toBeGreaterThan(resultQualityScore(base));
  expect(resultQualityScore({ ...base, snippet: "copy a direct link" })).toBeLessThan(resultQualityScore(base));
});

test("selectPassages returns the query-densest window", () => {
  const text =
    "Intro paragraph with little relevance here. " +
    "The bun test runner is fast and supports typescript out of the box. ".repeat(3) +
    "Closing unrelated words.";
  const passages = selectPassages(text, "bun test runner typescript", 2);
  expect(passages.length).toBeGreaterThan(0);
  expect(passages[0]!.text.toLowerCase()).toContain("bun test runner");
  expect(passages[0]!.score).toBeGreaterThan(0);
});

test("queryTerms drops short/stopword-ish tokens and dedupes", () => {
  expect(queryTerms("How do I use the Bun bun runtime?")).toEqual(["how", "use", "the", "bun", "runtime"]);
});

test("expandQueries widens a question into complementary phrasings", () => {
  const qs = expandQueries("how do I configure bun test");
  expect(qs[0]).toBe("how do I configure bun test");
  expect(qs.length).toBeGreaterThan(1);
  expect(qs.some((q) => q.includes("guide"))).toBe(true);
});

test("detectDate prefers ISO dates, falls back to a bare year", () => {
  expect(detectDate("released 2024-03-15 to users")).toBe("2024-03-15");
  expect(detectDate("a 2023 retrospective")).toBe("2023");
  expect(detectDate("no date here")).toBeUndefined();
});

test("detectDate rejects an impossible ISO date rather than normalizing it", () => {
  // 2025-13-45 must not be accepted (Date.UTC would silently roll it over).
  expect(detectDate("build 2025-13-45 failed")).toBe("2025"); // falls back to the bare year
  expect(detectDate("valid 2025-06-15 and junk 2025-99-99")).toBe("2025-06-15");
});

test("freshnessBoost does not award a future date the max boost", () => {
  const now = Date.UTC(2026, 0, 1);
  expect(freshnessBoost("2099-01-01", now)).toBe(0); // future → not fresh
  expect(freshnessBoost("2025-06-01", now)).toBe(3); // within a year → +3
  expect(freshnessBoost(undefined, now)).toBe(0);
});

test("expandQueries recency variant uses the CURRENT year, not a hardcoded one", () => {
  const y = new Date().getUTCFullYear();
  const qs = expandQueries("how do I deploy nextjs");
  const recency = qs.find((q) => /\d{4} OR \d{4}/.test(q));
  expect(recency).toBeDefined();
  expect(recency).toContain(`${y - 1} OR ${y}`);
  expect(recency).not.toContain("2024 OR 2025"); // the old hardcoded pair (unless it IS this year)
});

test("scorePage applies host boosts/penalties to www-prefixed hosts too", () => {
  const base = { url: "https://x/y", title: "t", text: "content here", date: undefined };
  const gh = scorePage({ ...base, domain: "www.github.com" }, []);
  const ghBare = scorePage({ ...base, domain: "github.com" }, []);
  expect(gh).toBe(ghBare); // www. no longer skips the +4 github boost
  const npm = scorePage({ ...base, domain: "www.npmjs.com" }, []);
  const other = scorePage({ ...base, domain: "example.com" }, []);
  expect(npm).toBeLessThan(other); // the −2 npm penalty applies to www.npmjs.com
});

test("scorePage does not mangle a real www.<tld> host to a bare TLD", () => {
  const base = { url: "https://x/y", title: "t", text: "content", date: undefined };
  // www.com / www.io ARE real domains — the www-strip must not turn them into a
  // bare TLD (which would be a non-host). No crash, and no github/npm host match.
  const wwwCom = scorePage({ ...base, domain: "www.com" }, []);
  const wwwIo = scorePage({ ...base, domain: "www.io" }, []);
  expect(Number.isFinite(wwwCom)).toBe(true);
  expect(Number.isFinite(wwwIo)).toBe(true);
  // www.github.com still gets the github boost (another label follows).
  const wwwGh = scorePage({ ...base, domain: "www.github.com" }, []);
  const gh = scorePage({ ...base, domain: "github.com" }, []);
  expect(wwwGh).toBe(gh);
});
