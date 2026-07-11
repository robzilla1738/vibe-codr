import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import type { ToolContext } from "@vibe/shared";
import { FreshnessRegistry } from "./freshness.ts";

const freshness = new FreshnessRegistry();
import { webfetchTool } from "./webfetch.ts";
import { createFetchCache } from "./fetch-cache.ts";

function ctx(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: "s",
    emit: () => {},
    toolCallId: "t",
    abortSignal: new AbortController().signal,
    freshness,
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
    new Response(body, {
      status,
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;
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
      return new Response(null, {
        status: 302,
        headers: { location: "https://second.example:8443/next" },
      });
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

test("htmlToText extraction is LINEAR on pathological unclosed tags (adversarial P6-W1)", () => {
  // A lazy `[\s\S]*?<\/tag>` scans to EOF for EACH unclosed opener, so
  // `"<script>".repeat(N)` cost O(N²) — a 703KB page froze webfetch ~31s (4× its
  // own 8s timeout), synchronously, so the AbortSignal never bounded it. Each of
  // these adversarial inputs must now complete near-instantly.
  for (const opener of ["<script>", "<pre>", "<h1>", "<style>", "<!--", "<footer>"]) {
    const evil = `${opener.repeat(90000)}x`; // ~0.4–0.7MB of unclosed openers
    const t0 = performance.now();
    const out = htmlToText(evil);
    const ms = performance.now() - t0;
    expect([opener, ms < 1000]).toEqual([opener, true]); // was tens of SECONDS; now single-digit ms
    expect(typeof out).toBe("string");
  }
});

test("htmlToText still preserves structure and strips blocks (linear rewrite parity)", () => {
  const out = htmlToText(
    "<head><style>.x{}</style></head><script>evil()</script><h1>Hi</h1><p>a <b>b</b> c</p>" +
      "<pre>code\nline</pre><nav>menu</nav><footer>foot</footer><ul><li>one</li><li>two</li></ul><!-- note -->",
  );
  expect(out).toContain("# Hi");
  expect(out).toContain("```");
  expect(out).toContain("code\nline");
  expect(out).toContain("- one");
  expect(out).toContain("- two");
  for (const gone of ["evil()", ".x{}", "menu", "foot", "note"]) expect(out).not.toContain(gone);
});

test("htmlToText keeps the body after a WHITESPACE-variant close tag (adversarial P7-1)", () => {
  // Valid HTML allows `</script >`, `</pre\n>`, `</h1 >`. An exact `/tag>` close
  // lookahead missed those, so the unrolled body ran to EOF and the optional close
  // DELETED the entire rest of the document. The close detector must tolerate
  // whitespace/attrs so the article body downstream of the block survives.
  const out = htmlToText(
    "<h1>Getting Started</h1><script>analytics()</script >" +
      "<h2 >Section 1</h2><p>body paragraph 1</p><pre>codeblock</pre >tail-after-pre<footer>foot</footer>",
  );
  expect(out).toContain("Section 1"); // whitespace-close heading
  expect(out).toContain("body paragraph 1"); // survives `</script >`
  expect(out).toContain("tail-after-pre"); // survives `</pre >`, NOT swallowed into the fence
  expect(out).not.toContain("analytics()"); // script still removed
  expect(out).not.toContain("foot");
});

test("htmlToText keeps `<…>` spans inside <pre> code (adversarial P9-1)", () => {
  // The <pre> pass decodes entities into the fence (`&lt;`→`<`), so a global
  // `<[^>]+>` catch-all running over the fence deleted real code spans — generics,
  // comparisons, shell redirects. Fence-protecting BEFORE the strip keeps code verbatim.
  const out = htmlToText(
    "<h1>Ex</h1><pre><code>if (a &lt; b &amp;&amp; c &gt; d) { x(); }\nlet v: Vec&lt;T&gt; = 0; cmd &gt; out</code></pre><p>after</p>",
  );
  expect(out).toContain("if (a < b && c > d) { x(); }"); // comparison span survived
  expect(out).toContain("Vec<T>"); // generic survived
  expect(out).toContain("cmd > out"); // shell redirect survived
  expect(out).toContain("# Ex");
  expect(out).toContain("after");
  // Outside a fence, `<…>` is still stripped as a tag (structure parity).
  const structure = htmlToText("<ul><li>one</li></ul><p>a <b>bold</b> word</p>");
  expect(structure).toContain("- one");
  expect(structure).toContain("a bold word");
  expect(structure).not.toContain("<b>");
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
  stubFetch("<p>a&amp;b &#38; c &lt;tag&gt; &#x2764; &mdash; end</p>", "text/html");
  const res = await fetcher().execute({ url: "https://example.com" }, ctx());
  const out = String(res.output);
  expect(out).toContain("a&b & c <tag> ❤ — end");
});

test("extracts text from a PDF response", async () => {
  const bytes = new Uint8Array(
    await Bun.file(join(import.meta.dir, "__fixtures__", "sample.pdf")).arrayBuffer(),
  );
  globalThis.fetch = (async () =>
    new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    })) as unknown as typeof fetch;
  const res = await fetcher().execute({ url: "https://example.com/doc.pdf" }, ctx());
  expect(res.isError).toBeUndefined();
  const out = String(res.output);
  expect(out).toContain("[PDF, 1 page]");
  expect(out).toContain("Hello PDF world");
});

test("uses an injected Readable extractor for HTML, falling back to htmlToText on null", async () => {
  stubFetch("<html><body><article>real body</article><nav>menu</nav></body></html>", "text/html");
  const readable = webfetchTool({ lookup: publicLookup, readable: () => "READABLE ARTICLE" });
  expect(String((await readable.execute({ url: "https://a.com" }, ctx())).output)).toBe(
    "READABLE ARTICLE",
  );

  stubFetch("<html><body><h1>Fallback</h1></body></html>", "text/html");
  const nullReadable = webfetchTool({ lookup: publicLookup, readable: () => null });
  expect(String((await nullReadable.execute({ url: "https://b.com" }, ctx())).output)).toContain(
    "Fallback",
  );
});

test("cache-through: a repeat fetch of the same URL is served from cache", async () => {
  const cache = createFetchCache({ ttlMs: 60_000 });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(`body ${calls}`, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }) as unknown as typeof fetch;
  const tool = webfetchTool({ lookup: publicLookup, cache });
  expect(String((await tool.execute({ url: "https://docs.example.com/x" }, ctx())).output)).toBe(
    "body 1",
  );
  // Second call is cached — fetch is not hit again.
  expect(String((await tool.execute({ url: "https://docs.example.com/x" }, ctx())).output)).toBe(
    "body 1",
  );
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
  expect(String((await tool.execute({ url: "https://docs.example.com/y" }, ctx())).output)).toBe(
    "cached body",
  );
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

// ---------------------------------------------------------------- research-grade fetch

import { decodeCharset, htmlToText, looksLikeShell, sameSite } from "./webfetch.ts";

test("sameSite: crawler bound allows http→https upgrade, refuses downgrade/off-host", () => {
  const base = "http://docs.example.com";
  // Identical origin.
  expect(sameSite("http://docs.example.com/guide", base)).toBe(true);
  // http→https upgrade on the same host (the common docs redirect) is allowed.
  expect(sameSite("https://docs.example.com/guide", base)).toBe(true);
  // https→http downgrade is refused.
  expect(sameSite("http://docs.example.com/x", "https://docs.example.com")).toBe(false);
  // A different host is refused even with the same scheme.
  expect(sameSite("http://evil.example.com/x", base)).toBe(false);
  // A different port is a different service.
  expect(sameSite("http://docs.example.com:8080/x", base)).toBe(false);
  // Malformed URL fails closed.
  expect(sameSite("not a url", base)).toBe(false);
});

test("requests carry a browser-like User-Agent (UA-less clients get 403'd)", async () => {
  let ua = "";
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    ua = (init?.headers as Record<string, string>)?.["user-agent"] ?? "";
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;
  await fetcher().execute({ url: "https://example.com/" }, ctx());
  expect(ua).toContain("Mozilla/5.0");
  expect(ua).toContain("vibecodr"); // honest about who we are, for server logs
});

test("decodeCharset honors Content-Type charset and meta-charset sniffing", () => {
  // windows-1252: 0x92 is a curly apostrophe.
  const cp1252 = new Uint8Array([0x92]);
  expect(decodeCharset(cp1252, "text/html; charset=windows-1252")).toBe("’");
  // UTF-8 bytes misdeclared as nothing: sniff the meta tag.
  const withMeta = new TextEncoder().encode('<html><head><meta charset="utf-8"></head>é</html>');
  expect(decodeCharset(withMeta, "text/html")).toContain("é");
  // Unknown label degrades to UTF-8 without throwing.
  expect(decodeCharset(new TextEncoder().encode("plain"), "text/html; charset=bogus-enc")).toBe(
    "plain",
  );
});

test("htmlToText preserves headings, lists, and code blocks as markdown-ish structure", () => {
  const html = `<html><body>
    <h1>Install</h1>
    <p>Run the following:</p>
    <pre><code>bun add   thing</code></pre>
    <h2>Options</h2>
    <ul><li>fast</li><li>safe</li></ul>
  </body></html>`;
  const text = htmlToText(html);
  expect(text).toContain("# Install");
  expect(text).toContain("## Options");
  expect(text).toContain("- fast");
  expect(text).toContain("- safe");
  // Code block fenced with inner whitespace preserved verbatim.
  expect(text).toContain("```\nbun add   thing\n```");
  // No wall-of-words collapse: headings sit on their own lines.
  expect(text).not.toMatch(/Install Run the following/);
});

test("a paywall/anti-bot shell is flagged, never silently returned as content", async () => {
  stubFetch(
    "<html><body>Checking your browser… enable JavaScript to continue</body></html>",
    "text/html",
  );
  const res = await webfetchTool({
    lookup: publicLookup,
    waybackLookup: async () => null, // no archive copy available
  }).execute({ url: "https://example.com/article" }, ctx());
  expect(String(res.output)).toContain("paywall/anti-bot shell");
  expect(looksLikeShell("Checking your browser… enable JavaScript")).toBe(true);
  expect(looksLikeShell("A real article. ".repeat(200))).toBe(false);
});

test("a 404 recovers via the Wayback snapshot, clearly labeled as archived", async () => {
  let call = 0;
  globalThis.fetch = (async (u: unknown) => {
    call++;
    // The snapshot fetch is DNS-pinned (hostname replaced by the verified IP),
    // so match on the snapshot PATH, not the archive hostname.
    if (String(u).includes("/web/2024/")) {
      return new Response("the original article text", {
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("gone", { status: 404 });
  }) as unknown as typeof fetch;
  const res = await webfetchTool({
    lookup: publicLookup,
    waybackLookup: async () => ({
      url: "https://web.archive.org/web/2024/https://example.com/dead",
      timestamp: "20240115000000",
    }),
  }).execute({ url: "https://example.com/dead" }, ctx());
  expect(res.isError).toBeUndefined();
  expect(String(res.output)).toContain("archived copy from the Wayback Machine, 2024-01-15");
  expect(String(res.output)).toContain("the original article text");
  expect(call).toBeGreaterThanOrEqual(2);
});

test("an SSRF-guard rejection does NOT consult the Wayback Machine (no URL leak)", async () => {
  let waybackAsked = false;
  const res = await webfetchTool({
    waybackLookup: async () => {
      waybackAsked = true;
      return null;
    },
  }).execute({ url: "http://169.254.169.254/latest/meta-data/" }, ctx());
  expect(res.isError).toBe(true);
  expect(waybackAsked).toBe(false);
});

test("Wayback is NOT consulted for an internal URL even when allowPrivateHosts is set", async () => {
  // allowPrivateHosts lets the LIVE fetch reach the intranet host; its genuine
  // HTTP 404 would otherwise fall through to the archive.org lookup and leak the
  // internal host + path + token to a public third party.
  let waybackAsked = false;
  const privateLookup = async () => [{ address: "10.0.0.5" }]; // intranet resolves private
  globalThis.fetch = (async () =>
    new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;
  const res = await webfetchTool({
    allowPrivateHosts: true,
    lookup: privateLookup,
    waybackLookup: async () => {
      waybackAsked = true;
      return { url: "https://web.archive.org/web/2024/x" };
    },
  }).execute({ url: "http://intranet.corp/admin?token=SECRET" }, ctx());
  expect(res.isError).toBe(true);
  expect(String(res.output)).toContain("HTTP 404");
  expect(waybackAsked).toBe(false); // the internal URL never reached archive.org
});

test("readBodyCapped: a null-body response with an oversized content-length is refused, not buffered whole", async () => {
  const { readBodyCapped } = await import("./webfetch.ts");
  // A bodyless Response whose declared length exceeds the cap: the streaming OOM
  // ceiling can't apply, so it must refuse rather than arrayBuffer() the lot.
  const big = new Response(null, { headers: { "content-length": String(50_000_000) } });
  const r = await readBodyCapped(big, 4_000_000);
  expect(r.truncated).toBe(true);
  expect(r.bytes.length).toBe(0);
  // A small bodyless response (no/low content-length) still reads normally.
  const small = new Response(null, { headers: { "content-length": "0" } });
  const r2 = await readBodyCapped(small, 4_000_000);
  expect(r2.truncated).toBe(false);
});
