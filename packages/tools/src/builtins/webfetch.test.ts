import { test, expect, afterEach } from "bun:test";
import type { ToolContext } from "@vibe/shared";
import { webfetchTool } from "./webfetch.ts";

function ctx(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: "s",
    emit: () => {},
    toolCallId: "t",
    abortSignal: new AbortController().signal,
  };
}

// A public IP so the SSRF guard passes without touching the real network.
const publicLookup = async () => [{ address: "93.184.216.34" }];
// Build the tool with the test lookup injected (no real DNS in unit tests).
const fetcher = () => webfetchTool({ lookup: publicLookup });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(body: string, contentType: string, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { "content-type": contentType } })) as unknown as typeof fetch;
}

test("reduces HTML to readable text, stripping scripts/styles/tags", async () => {
  stubFetch(
    "<html><head><style>.x{color:red}</style><script>evil()</script></head><body><h1>Title</h1><p>Hello&nbsp;world</p></body></html>",
    "text/html",
  );
  const res = await fetcher().execute({ url: "https://example.com" }, ctx());
  expect(res.isError).toBeUndefined();
  const out = String(res.output);
  expect(out).toContain("Title");
  expect(out).toContain("Hello world");
  expect(out).not.toContain("evil()");
  expect(out).not.toContain("color:red");
  expect(out).not.toContain("<");
});

test("returns non-HTML bodies verbatim", async () => {
  stubFetch('{"ok":true}', "application/json");
  const res = await fetcher().execute({ url: "https://api.example.com/x" }, ctx());
  expect(String(res.output)).toBe('{"ok":true}');
});

test("maxChars governs truncation and reports how much was dropped", async () => {
  const big = "x".repeat(40_000);
  stubFetch(big, "text/plain");
  // Skim: cap to 100 chars.
  const skim = await fetcher().execute({ url: "https://e.com", maxChars: 100 }, ctx());
  const out = String(skim.output);
  expect(out).toContain("…(truncated");
  expect(out).toContain("raise maxChars");
  expect(out.startsWith("x".repeat(100))).toBe(true);
  // Read in full: a large cap returns everything, no truncation marker.
  stubFetch(big, "text/plain");
  const full = await fetcher().execute({ url: "https://e.com", maxChars: 100_000 }, ctx());
  expect(String(full.output)).toBe(big);
});

test("a non-OK HTTP status is an error", async () => {
  stubFetch("not found", "text/plain", 404);
  const res = await fetcher().execute({ url: "https://example.com/missing" }, ctx());
  expect(res.isError).toBe(true);
  expect(String(res.output)).toContain("HTTP 404");
});

test("a network failure is reported cleanly, not thrown", async () => {
  globalThis.fetch = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const res = await fetcher().execute({ url: "https://example.com" }, ctx());
  expect(res.isError).toBe(true);
  expect(String(res.output)).toContain("Fetch failed");
});

test("refuses an SSRF target (cloud metadata) without ever fetching it", async () => {
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("secret", { status: 200 });
  }) as unknown as typeof fetch;
  // Default policy (no allowPrivateHosts); IP literal needs no DNS.
  const res = await webfetchTool().execute(
    { url: "http://169.254.169.254/latest/meta-data/iam/" },
    ctx(),
  );
  expect(fetched).toBe(false);
  expect(res.isError).toBe(true);
  expect(String(res.output)).toMatch(/refusing|private/i);
});

test("re-validates redirects, blocking a redirect into an internal host", async () => {
  let calls = 0;
  globalThis.fetch = (async (_url: string) => {
    calls++;
    // First (public) hop 302s to the metadata service.
    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/" },
    });
  }) as unknown as typeof fetch;
  const res = await webfetchTool({ lookup: publicLookup }).execute(
    { url: "https://safe.example.com/go" },
    ctx(),
  );
  expect(calls).toBe(1); // followed once, then the guard blocked hop 2
  expect(res.isError).toBe(true);
  expect(String(res.output)).toMatch(/refusing|private/i);
});

test("decodes numeric and named HTML entities", async () => {
  stubFetch(
    "<p>a&amp;b &#38; c &lt;tag&gt; &#x2764; &mdash; end</p>",
    "text/html",
  );
  const res = await fetcher().execute({ url: "https://example.com" }, ctx());
  const out = String(res.output);
  expect(out).toContain("a&b & c <tag> ❤ — end");
});
