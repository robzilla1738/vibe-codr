import { test, expect, afterEach } from "bun:test";
import type { ToolContext } from "@vibe/shared";
import { crawlDocsTool, extractLinks } from "./crawl-docs.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function ctx(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: "s",
    emit: () => {},
    toolCallId: "t",
    abortSignal: new AbortController().signal,
  };
}

const page = (title: string, body: string, links: string[] = []) =>
  `<html><body><h1>${title}</h1><p>${body}</p>${links.map((l) => `<a href="${l}">x</a>`).join("")}</body></html>`;

test("extractLinks keeps same-origin doc links, drops assets/offsite/fragments", () => {
  const html = page("t", "b", [
    "/guide/config",
    "https://docs.example.com/api#anchor",
    "https://other.example.com/away",
    "/logo.png",
    "mailto:x@y.z",
  ]);
  const links = extractLinks(html, "https://docs.example.com/start");
  expect(links).toContain("https://docs.example.com/guide/config");
  expect(links).toContain("https://docs.example.com/api");
  expect(links.some((l) => l.includes("other.example.com"))).toBe(false);
  expect(links.some((l) => l.includes(".png"))).toBe(false);
});

test("crawls breadth-first, ranks by query relevance, quotes excerpts", async () => {
  const site: Record<string, string> = {
    "https://docs.example.com/": page("Home", "welcome to the docs", ["/config", "/about"]),
    "https://docs.example.com/config": page(
      "Configuration",
      "set the retry backoff option in config.json to control retry backoff timing for failed requests",
    ),
    "https://docs.example.com/about": page("About", "we are a company that makes things"),
  };
  const fetched: string[] = [];
  const res = await crawlDocsTool({
    fetchPage: async (url) => {
      fetched.push(url);
      const body = site[url];
      if (!body) throw new Error("HTTP 404");
      return body;
    },
  }).execute({ url: "https://docs.example.com/", query: "retry backoff option" }, ctx());

  expect(res.isError).toBeUndefined();
  const out = String(res.output);
  // The config page (relevant) ranks first and carries a quoted excerpt.
  expect(out.indexOf("/config")).toBeLessThan(out.indexOf("/about") === -1 ? out.length : out.indexOf("/about"));
  expect(out).toContain("> ");
  expect(out).toContain("retry backoff");
  expect(fetched[0]).toBe("https://docs.example.com/");
});

test("respects the page budget and reports fetch failures without failing", async () => {
  const many = Array.from({ length: 30 }, (_, i) => `/p${i}`);
  let calls = 0;
  const res = await crawlDocsTool({
    fetchPage: async (url) => {
      calls++;
      if (url.endsWith("/p3")) throw new Error("HTTP 500");
      return page("P", `content about widgets ${url}`, many);
    },
  }).execute({ url: "https://d.example.com/", query: "widgets", maxPages: 5 }, ctx());
  expect(calls).toBeLessThanOrEqual(5);
  expect(String(res.output)).toContain("failed to fetch");
});

test("a server-side redirect off the crawl origin is refused, never stored", async () => {
  // The default fetcher (guardedFetchText) is exercised here so the same-origin
  // bound is enforced THROUGH redirects, not just at link extraction. A
  // same-origin open-redirector that 302s to an external host must not have its
  // content pulled back under the trusted docs domain.
  const seen: string[] = [];
  globalThis.fetch = (async (u: unknown) => {
    const s = String(u);
    seen.push(s);
    if (s.includes("/start")) {
      return new Response(
        `<html><body><h1>Docs</h1><a href="https://docs.example.com/r">redirect</a></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (s.includes("/r")) {
      return new Response(null, { status: 302, headers: { location: "https://tracker.evil.com/spy" } });
    }
    return new Response("ATTACKER CONTENT", { headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;

  const res = await crawlDocsTool({
    lookup: async () => [{ address: "93.184.216.34" }], // public — SSRF guard passes
  }).execute({ url: "https://docs.example.com/start", query: "anything" }, ctx());

  const out = String(res.output);
  expect(out).not.toContain("ATTACKER CONTENT");
  expect(out).toContain("failed to fetch"); // the off-origin hop was refused
  // The external host was never actually fetched (the guard threw first).
  expect(seen.some((s) => s.includes("evil.com"))).toBe(false);
});

test("a completely dead site errors cleanly", async () => {
  const res = await crawlDocsTool({
    fetchPage: async () => {
      throw new Error("HTTP 404");
    },
  }).execute({ url: "https://gone.example.com/", query: "anything" }, ctx());
  expect(res.isError).toBe(true);
  expect(String(res.output)).toContain("no readable pages");
});
