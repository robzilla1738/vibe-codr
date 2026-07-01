import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import type { ToolContext } from "@vibe/shared";
import { webfetchTool } from "./webfetch.ts";
import { createFetchCache } from "./fetch-cache.ts";

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

test("connects to the guard-verified IP (DNS pinning), keeping the original Host + SNI", async () => {
  // Capture what URL/options fetch actually receives — it must be the pinned IP,
  // not the hostname, so a DNS rebind can't redirect the real connection.
  let seenUrl = "";
  let seenInit: (RequestInit & { tls?: { serverName?: string } }) | undefined;
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    seenUrl = String(u);
    seenInit = init as never;
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;

  await webfetchTool({ lookup: async () => [{ address: "93.184.216.34" }] }).execute(
    { url: "https://example.com/docs?q=1" },
    ctx(),
  );
  // Connected to the IP, preserving path/query…
  expect(seenUrl).toBe("https://93.184.216.34/docs?q=1");
  // …with the real Host header and TLS SNI so routing + cert validation still work.
  expect((seenInit?.headers as Record<string, string>)?.host).toBe("example.com");
  expect(seenInit?.tls?.serverName).toBe("example.com");
});

test("re-pins each redirect hop, brackets an IPv6 pinned address, and keeps the port", async () => {
  const seen: string[] = [];
  let hop = 0;
  globalThis.fetch = (async (u: unknown) => {
    seen.push(String(u));
    if (hop++ === 0) {
      return new Response(null, { status: 302, headers: { location: "https://second.example:8443/next" } });
    }
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;
  // Different hosts resolve to different families — the first hop pins to v4, the
  // redirect target re-resolves and pins to its (public) IPv6, bracketed + port kept.
  const lookup = async (host: string) =>
    host === "first.example"
      ? [{ address: "93.184.216.34" }]
      : [{ address: "2606:2800:220:1:248:1893:25c8:1946" }];
  await webfetchTool({ lookup }).execute({ url: "https://first.example/start" }, ctx());
  expect(seen[0]).toBe("https://93.184.216.34/start");
  expect(seen[1]).toBe("https://[2606:2800:220:1:248:1893:25c8:1946]:8443/next");
});

test("an IP-literal target is fetched as-is (no pinning rewrite)", async () => {
  let seenUrl = "";
  globalThis.fetch = (async (u: unknown) => {
    seenUrl = String(u);
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;
  await webfetchTool({ lookup: async () => [{ address: "93.184.216.34" }] }).execute(
    { url: "http://93.184.216.34/path" },
    ctx(),
  );
  expect(seenUrl).toBe("http://93.184.216.34/path");
});

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

test("extracts text from a PDF response", async () => {
  const bytes = new Uint8Array(
    await Bun.file(join(import.meta.dir, "__fixtures__", "sample.pdf")).arrayBuffer(),
  );
  globalThis.fetch = (async () =>
    new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
  const res = await fetcher().execute({ url: "https://example.com/doc.pdf" }, ctx());
  expect(res.isError).toBeUndefined();
  const out = String(res.output);
  expect(out).toContain("[PDF, 1 page]");
  expect(out).toContain("Hello PDF world");
});

test("uses an injected Readable extractor for HTML, falling back to htmlToText on null", async () => {
  stubFetch("<html><body><article>real body</article><nav>menu</nav></body></html>", "text/html");
  const readable = webfetchTool({ lookup: publicLookup, readable: () => "READABLE ARTICLE" });
  expect(String((await readable.execute({ url: "https://a.com" }, ctx())).output)).toBe("READABLE ARTICLE");

  stubFetch("<html><body><h1>Fallback</h1></body></html>", "text/html");
  const nullReadable = webfetchTool({ lookup: publicLookup, readable: () => null });
  expect(String((await nullReadable.execute({ url: "https://b.com" }, ctx())).output)).toContain("Fallback");
});

test("cache-through: a repeat fetch of the same URL is served from cache", async () => {
  const cache = createFetchCache({ ttlMs: 60_000 });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(`body ${calls}`, { status: 200, headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;
  const tool = webfetchTool({ lookup: publicLookup, cache });
  expect(String((await tool.execute({ url: "https://docs.example.com/x" }, ctx())).output)).toBe("body 1");
  // Second call is cached — fetch is not hit again.
  expect(String((await tool.execute({ url: "https://docs.example.com/x" }, ctx())).output)).toBe("body 1");
  expect(calls).toBe(1);
});

test("cache-through: stale-on-failure serves the last good copy when the live fetch fails", async () => {
  const cache = createFetchCache({ ttlMs: 0 }); // always stale after storing → forces re-fetch
  let mode: "ok" | "fail" = "ok";
  globalThis.fetch = (async () => {
    if (mode === "fail") throw new Error("connection refused");
    return new Response("cached body", { status: 200, headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;
  const tool = webfetchTool({ lookup: publicLookup, cache });
  expect(String((await tool.execute({ url: "https://docs.example.com/y" }, ctx())).output)).toBe("cached body");
  mode = "fail";
  const stale = await tool.execute({ url: "https://docs.example.com/y" }, ctx());
  expect(stale.isError).toBeUndefined();
  expect(String(stale.output)).toContain("served a cached copy");
  expect(String(stale.output)).toContain("cached body");
});

test("pinning preserves embedded credentials (Basic auth) in the URL", async () => {
  let seenUrl = "";
  globalThis.fetch = (async (u: unknown) => {
    seenUrl = String(u);
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;
  await webfetchTool({ lookup: async () => [{ address: "93.184.216.34" }] }).execute(
    { url: "https://user:pass@example.com/secure" },
    ctx(),
  );
  expect(seenUrl).toBe("https://user:pass@93.184.216.34/secure"); // creds kept, IP pinned
});
