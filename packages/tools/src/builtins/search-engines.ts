/**
 * Pluggable web-search engines. The keyless DuckDuckGo HTML endpoint is the
 * always-available default (so `web_search` works with no API key); TinyFish is
 * an optional higher-quality booster when a key is configured. The HTML parser
 * is pure and unit-tested; the network fetch is injectable so tests stay hermetic.
 */

export interface SearchResult {
  position: number;
  site_name: string;
  title: string;
  snippet: string;
  url: string;
}

export interface EngineOptions {
  recencyDays?: number;
  maxResults?: number;
}

/** Minimal fetch shape (so a stub can satisfy it without the full Response API). */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0";

/** Decode the handful of HTML entities that show up in result text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Strip tags and collapse whitespace from an HTML fragment. */
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Resolve a DuckDuckGo result href to the real destination URL. */
function resolveDdgHref(href: string): string {
  const uddg = href.match(/[?&]uddg=([^&]+)/);
  if (uddg?.[1]) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return "";
    }
  }
  if (href.startsWith("//")) return `https:${href}`;
  return href.startsWith("http") ? href : "";
}

/** Parse a DuckDuckGo HTML results page into structured results (pure).
 *
 * The anchor-body captures are the LINEAR unrolled form `(?:[^<]|<(?!\/a[\s>]))*`
 * with an optional close — NOT a lazy `[\s\S]*?<\/a>`, which re-scans to EOF for
 * every unclosed `<a …>` opener → O(n²) and froze the (uncapped, synchronous)
 * keyless-search parse on an oversized/garbled results page (~4.5s at 720KB). */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>((?:[^<]|<(?!\/a[\s>]))*)(?:<\/a[^>]*>)?/g;
  const snippets = [...html.matchAll(snippetRe)].map((m) => stripTags(m[1] ?? ""));
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>((?:[^<]|<(?!\/a[\s>]))*)(?:<\/a[^>]*>)?/g;
  const results: SearchResult[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html)) !== null) {
    const url = resolveDdgHref(decodeEntities(m[1] ?? ""));
    const title = stripTags(m[2] ?? "");
    if (!url || !title) continue;
    results.push({
      position: i + 1,
      site_name: hostOf(url),
      title,
      url,
      snippet: snippets[i] ?? "",
    });
    i++;
  }
  return results;
}

/** Map a recency window (days) to DuckDuckGo's `df` (day/week/month/year). */
function recencyToDf(days: number): string {
  if (days <= 1) return "d";
  if (days <= 7) return "w";
  if (days <= 31) return "m";
  return "y";
}

/** Bing's recency filter (`ex1:"ez<N>"`): 1=24h, 2=week, 3=month; no year window. */
function recencyToBingFilter(days: number): string | undefined {
  if (days <= 1) return "ez1";
  if (days <= 7) return "ez2";
  if (days <= 31) return "ez3";
  return undefined;
}

/** Bing wraps result URLs in a `/ck/` redirect with a base64url-encoded `u` param. */
function decodeBingUrl(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href, "https://www.bing.com");
  } catch {
    return null;
  }
  if (!u.hostname.endsWith("bing.com") || !u.pathname.startsWith("/ck/")) return href;
  const encoded = u.searchParams.get("u");
  if (!encoded) return null;
  const value = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, "base64url").toString("utf8");
    return decoded.startsWith("http://") || decoded.startsWith("https://") ? decoded : null;
  } catch {
    return null;
  }
}

/** Parse a Bing HTML results page into structured results (pure). Each hit is an
 * `<li class="b_algo">` with an `<h2><a>` link and a `<p>` snippet. */
export function parseBingHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<li class="b_algo[^"]*"/i).slice(1);
  let i = 0;
  for (const block of blocks) {
    const link = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = decodeBingUrl(decodeEntities(link[1] ?? ""));
    if (!url || !/^https?:\/\//.test(url)) continue;
    const title = stripTags(link[2] ?? "");
    if (!title) continue;
    const sn = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = sn ? stripTags(sn[1] ?? "") : "";
    results.push({ position: i + 1, site_name: hostOf(url), title, url, snippet });
    i++;
  }
  return results;
}

/** Keyless web search via Bing's HTML endpoint (a second scraper so a DDG parse
 * break or block doesn't take web_search dark). */
export async function bingSearch(
  query: string,
  opts: EngineOptions,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  if (opts.recencyDays !== undefined) {
    const ez = recencyToBingFilter(opts.recencyDays);
    if (ez) url.searchParams.set("filters", `ex1:"${ez}"`);
  }
  const res = await fetchImpl(url.toString(), {
    headers: { "user-agent": BROWSER_UA, "accept-language": "en-US,en;q=0.9", accept: "text/html" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const all = parseBingHtml(await res.text());
  return opts.maxResults ? all.slice(0, opts.maxResults) : all;
}

/** Keyless web search via DuckDuckGo's HTML endpoint. */
export async function duckDuckGoSearch(
  query: string,
  opts: EngineOptions,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  if (opts.recencyDays !== undefined) url.searchParams.set("df", recencyToDf(opts.recencyDays));
  const res = await fetchImpl(url.toString(), {
    headers: { "user-agent": BROWSER_UA, accept: "text/html" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const all = parseDuckDuckGoHtml(await res.text());
  return opts.maxResults ? all.slice(0, opts.maxResults) : all;
}

/**
 * A tiny per-engine cooldown so a transiently blocking engine (429/403) is
 * skipped for a while instead of retried on every query. In-process; `now` is
 * injectable for tests.
 */
export function createCooldown(windowMs = 60_000) {
  const until = new Map<string, number>();
  return {
    blocked(name: string, now: number): boolean {
      return (until.get(name) ?? 0) > now;
    },
    trip(name: string, now: number): void {
      until.set(name, now + windowMs);
    },
    /** Clear all cooldowns (test hook, so test order can't leak state). */
    clear(): void {
      until.clear();
    },
  };
}
