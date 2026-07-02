import { z } from "zod";
import { isIP } from "node:net";
import { readCappedBytes, type ToolDefinition } from "@vibe/shared";
import { assertFetchAllowed, type FetchPolicy, type Lookup } from "./net-guard.ts";
import { extractPdfText } from "./pdftext.ts";
import type { FetchCache } from "./fetch-cache.ts";

const Input = z.object({
  url: z.string().url().describe("URL to fetch."),
  maxChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Max characters of text to return (default 25000). Raise it to read a long " +
        "page (docs, changelog) in full; lower it to skim.",
    ),
});

const DEFAULT_MAX_CHARS = 25_000;
const DEFAULT_TIMEOUT_MS = 8_000;
/** Hard ceiling on bytes pulled off the wire, before the char cap, so a huge or
 * unbounded response can't OOM the process. */
const DEFAULT_MAX_BYTES = 4_000_000;
const MAX_REDIRECTS = 5;

/** Named HTML entities worth decoding (the long tail is rare in body text). */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Decode named + numeric (decimal/hex) HTML character references. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? m;
  });
}

/**
 * HTML -> structure-preserving markdown-ish text: headings become `#` lines,
 * list items become `- ` bullets, `<pre>` blocks become fenced code, and block
 * boundaries become newlines — instead of collapsing the whole document into
 * one wall of whitespace-mashed words (which destroyed the heading/list/code
 * structure models need to comprehend docs pages). Dependency-free.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<(?:aside|template)[\s\S]*?<\/(?:aside|template)>/gi, " ");
  // Code blocks first (their inner whitespace must survive verbatim).
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, body: string) => {
    const code = decodeEntities(body.replace(/<[^>]+>/g, "")).replace(/^\n+|\n+$/g, "");
    return `\n\`\`\`\n${code}\n\`\`\`\n`;
  });
  // Headings → markdown heading lines.
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, body: string) => {
    const text = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "\n";
  });
  // List items → bullets; block-level closers → line breaks; cells → separators.
  s = s
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|section|article|li|ul|ol|table|blockquote|figure)>/gi, "\n")
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  // Collapse whitespace per line (never across lines), keep fenced code intact.
  const parts = s.split(/(```[\s\S]*?```)/);
  const cleaned = parts
    .map((part, i) =>
      i % 2 === 1
        ? part // inside a fence — verbatim
        : decodeEntities(part)
            .split("\n")
            .map((line) => line.replace(/[ \t]+/g, " ").trim())
            .join("\n")
            .replace(/\n{3,}/g, "\n\n"),
    )
    .join("\n");
  return cleaned.trim();
}

/** Markers that make a tiny page read as a paywall / anti-bot shell rather than
 * real content — flagged so a login wall never silently becomes a "fact". */
const SHELL_MARKERS =
  /enable javascript|verify you are (a )?human|captcha|cloudflare|access denied|subscribe to (read|continue)|sign in to (read|continue)|are you a robot|attention required|checking your browser/i;

/** True when the extracted text looks like a blocker shell, not the article. */
export function looksLikeShell(text: string): boolean {
  return text.length < 1_200 && SHELL_MARKERS.test(text);
}

/** Extract the main article text with Mozilla Readability, when the optional
 * peer deps (`@mozilla/readability` + `linkedom`) are installed. Returns null on
 * any failure so the caller falls back to {@link htmlToText}. The loader is
 * memoized so a missing dep is probed only once. */
type ReadableFn = (html: string, url: string) => string | null;
let readableLoader: Promise<ReadableFn | null> | undefined;
function loadReadable(): Promise<ReadableFn | null> {
  if (readableLoader) return readableLoader;
  readableLoader = (async () => {
    try {
      // Non-literal specifiers: absent deps degrade to htmlToText, never throw at boot.
      const linkedom = (await import("linkedom" as string)) as {
        parseHTML: (html: string) => { document: unknown };
      };
      const readability = (await import("@mozilla/readability" as string)) as {
        Readability: new (doc: unknown) => { parse: () => { textContent?: string } | null };
      };
      return (html: string, _url: string): string | null => {
        try {
          const { document } = linkedom.parseHTML(html);
          const article = new readability.Readability(document).parse() as {
            content?: string;
            textContent?: string;
          } | null;
          // Prefer the article's HTML through the structure-preserving converter
          // (headings/lists/code survive); fall back to flat textContent.
          if (article?.content) {
            const md = htmlToText(article.content);
            if (md.length > 0) return md;
          }
          const text = article?.textContent?.replace(/\s+/g, " ").trim();
          return text && text.length > 0 ? text : null;
        } catch {
          return null;
        }
      };
    } catch {
      return null; // deps not installed
    }
  })();
  return readableLoader;
}

/** Read a response body up to `maxBytes` as raw bytes. Returns the bytes and
 * whether the body was truncated at the cap. Streams via the shared byte reader
 * when a body stream is present; falls back to `arrayBuffer()` when it isn't. */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (res.body) return readCappedBytes(res.body, maxBytes);
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length > maxBytes
    ? { bytes: buf.subarray(0, maxBytes), truncated: true }
    : { bytes: buf, truncated: false };
}

export interface WebfetchOptions extends FetchPolicy {
  /** Wall-clock cap per fetch (ms). Default 8000. */
  timeoutMs?: number;
  /** Byte ceiling pulled off the wire before the char cap. Default 4MB. */
  maxBytes?: number;
  /** Injectable DNS lookup for the SSRF guard (tests). */
  lookup?: Lookup;
  /** Optional cache-through store (per-URL TTL + stale-on-failure). */
  cache?: FetchCache;
  /** Injectable Readable-article extractor (tests). Falls back to htmlToText on null. */
  readable?: ReadableFn;
  /** Injectable Wayback snapshot lookup (tests). Returns the snapshot URL +
   * timestamp for a dead page, or null when none exists. Defaults to the
   * archive.org availability API. */
  waybackLookup?: (url: string, signal: AbortSignal) => Promise<{ url: string; timestamp?: string } | null>;
}

/** Query archive.org for the closest snapshot of `url`. Best-effort. */
async function defaultWaybackLookup(
  url: string,
  signal: AbortSignal,
): Promise<{ url: string; timestamp?: string } | null> {
  try {
    const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const res = await fetch(api, { signal, headers: { "user-agent": USER_AGENT } });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      archived_snapshots?: { closest?: { available?: boolean; url?: string; timestamp?: string } };
    };
    const snap = data.archived_snapshots?.closest;
    if (!snap?.available || !snap.url) return null;
    return { url: snap.url, ...(snap.timestamp ? { timestamp: snap.timestamp } : {}) };
  } catch {
    return null;
  }
}

/**
 * Fetch a URL and reduce it to text — hardened: an SSRF allowlist (no
 * loopback/link-local/metadata/private hosts by default), redirects followed
 * manually so every hop is re-validated, a wall-clock timeout, and a streaming
 * byte cap so an unbounded response can't hang the turn or OOM the process. PDFs
 * are extracted to text (zero-dep); HTML uses Readability when available and
 * otherwise a built-in tag-stripper. An optional cache serves repeat/failed
 * fetches from a per-URL store.
 */
export function webfetchTool(opts: WebfetchOptions = {}): ToolDefinition<z.infer<typeof Input>> {
  const policy: FetchPolicy = {
    ...(opts.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
    ...(opts.allowHosts ? { allowHosts: opts.allowHosts } : {}),
  };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    name: "webfetch",
    description:
      "Fetch a URL and return its text content (HTML is reduced to readable text; " +
      "PDFs are extracted to text). Use when you need the full page — a `web_search` " +
      "snippet wasn't enough, or you have a specific URL (docs, changelog, raw file) " +
      "to read in full. Control how much comes back with `maxChars`.",
    inputSchema: Input,
    readOnly: true,
    network: true,
    concurrencySafe: true,
    async execute({ url, maxChars }, ctx) {
      const signal = AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(timeoutMs)]);

      // Fetch ONE url through the shared guard/redirect/extract pipeline (also
      // used by web_search's deep-mode enrichment, so both surfaces get the
      // same SSRF pinning). Throws on any failure; the guard runs INSIDE so a
      // block is never bypassed by the cache or the Wayback fallback.
      const fetchOne = (startUrl: string): Promise<string> =>
        guardedFetchText(startUrl, {
          policy,
          maxBytes,
          signal,
          ...(opts.lookup ? { lookup: opts.lookup } : {}),
          ...(opts.readable ? { readable: opts.readable } : {}),
        });

      // Ask the Wayback Machine for the closest snapshot and fetch it (through
      // the same guarded pipeline). Returns null when there's no usable copy —
      // callers keep their original failure. Labeled so an archived copy is
      // never mistaken for the live page.
      const fetchWayback = async (): Promise<string | null> => {
        try {
          // Never disclose an internal/private URL to archive.org — even when the
          // policy opts internal hosts in for the LIVE fetch. The wayback lookup
          // embeds the raw url (host + path + query, incl. tokens) in a public
          // request, so gate it on the DEFAULT-DENY policy (no allow overrides):
          // a non-public target simply forfeits the archive fallback.
          try {
            await assertFetchAllowed(url, {}, opts.lookup);
          } catch {
            return null;
          }
          const snap = await (opts.waybackLookup ?? defaultWaybackLookup)(url, signal);
          if (!snap) return null;
          const text = await fetchOne(snap.url.replace(/^http:/, "https:"));
          const when = snap.timestamp
            ? `${snap.timestamp.slice(0, 4)}-${snap.timestamp.slice(4, 6)}-${snap.timestamp.slice(6, 8)}`
            : "unknown date";
          return `[archived copy from the Wayback Machine, ${when} — the live page was unavailable]\n\n${text}`;
        } catch {
          return null;
        }
      };

      // The full extracted text (pre-char-cap) for one URL, with recovery: a
      // 4xx/5xx live page falls back to the closest Wayback snapshot, and a
      // paywall/anti-bot shell is flagged (and upgraded to the archive when
      // the archive has more) — a login wall must never read as the article.
      // The fallback fires ONLY on an HTTP-status failure: an SSRF-guard
      // rejection must propagate untouched (asking archive.org about a blocked
      // internal URL would leak it and sidestep the policy), and so must
      // aborts/timeouts.
      const fetchAndExtract = async (): Promise<string> => {
        let live: string;
        try {
          live = await fetchOne(url);
        } catch (err) {
          if (/^HTTP \d+ fetching /.test((err as Error).message ?? "")) {
            const archived = await fetchWayback();
            if (archived) return archived;
          }
          throw err;
        }
        if (looksLikeShell(live)) {
          const archived = await fetchWayback();
          if (archived && archived.length > live.length * 2) return archived;
          return `(warning: this page looks like a paywall/anti-bot shell — the text below may not be the real content)\n\n${live}`;
        }
        return live;
      };

      try {
        let full: string;
        let stale = false;
        if (opts.cache) {
          const r = await opts.cache.through(url, fetchAndExtract);
          full = r.text;
          stale = r.stale;
        } else {
          full = await fetchAndExtract();
        }
        const prefix = stale ? "(served a cached copy — the live fetch failed)\n\n" : "";
        const cap = maxChars ?? DEFAULT_MAX_CHARS;
        if (full.length > cap) {
          return {
            output: `${prefix}${full.slice(0, cap)}\n…(truncated ${full.length - cap} more chars; raise maxChars to read further)`,
          };
        }
        return { output: `${prefix}${full}` };
      } catch (err) {
        if (ctx.abortSignal.aborted) return { output: "Fetch aborted." };
        return { output: `Fetch failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

/** Options for one guarded fetch (the shared pipeline behind webfetch and
 * web_search deep-mode enrichment). */
export interface GuardedFetchOptions {
  policy?: FetchPolicy;
  lookup?: Lookup;
  maxBytes?: number;
  signal: AbortSignal;
  readable?: ReadableFn;
  /** Return the charset-decoded body VERBATIM (no HTML→text reduction) — for
   * callers that need the markup itself (link discovery in a crawler). */
  raw?: boolean;
  /** Confine the fetch (incl. every redirect hop) to this exact origin. A
   * server-side redirect that leaves it throws instead of being followed — so a
   * crawler's same-domain bound holds even against an open-redirector to an
   * external host, not just at link-extraction time. */
  sameOrigin?: string;
}

/**
 * Fetch one URL through the full hardened pipeline — SSRF guard re-validated on
 * every redirect hop, connection pinned to the guard-verified IP (Host + SNI
 * preserved), streaming byte cap, content-type-aware text extraction. Throws on
 * any failure. This is THE way to pull web text; never fetch a model-supplied
 * URL without it.
 */
export async function guardedFetchText(startUrl: string, opts: GuardedFetchOptions): Promise<string> {
  const policy = opts.policy ?? {};
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let current = startUrl;
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Same-domain confinement (crawler bound): re-checked on the FINAL resolved
    // URL of every hop, so a redirect off-origin can't smuggle external content
    // back under the crawl's trusted domain. Compared by host+port (not full
    // origin) with an http→https UPGRADE allowed: a docs site that 301s
    // http→https on the same host is legitimate and must not fail the crawl,
    // while a redirect to a different host — or an https→http DOWNGRADE — is still
    // refused.
    if (opts.sameOrigin && !sameSite(current, opts.sameOrigin)) {
      throw new Error(`refusing to follow a redirect off ${opts.sameOrigin} (to ${current})`);
    }
    const target = await assertFetchAllowed(current, policy, opts.lookup);
    // Connect to the exact IP the guard verified (when it resolved a hostname),
    // keeping the original Host header + TLS SNI, so a DNS rebind can't point
    // the actual connection at a private address. IP-literal / opted-in targets
    // have no pinnedIp and fetch the URL as-is.
    const r = await fetch(pinnedUrl(target.url, target.pinnedIp), pinnedInit(target, opts.signal));
    const location = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && location) {
      await r.body?.cancel?.().catch(() => {});
      current = new URL(location, current).toString();
      continue;
    }
    res = r;
    break;
  }
  if (!res) throw new Error(`Too many redirects fetching ${startUrl}`);
  if (!res.ok) {
    await res.body?.cancel?.().catch(() => {});
    throw new Error(`HTTP ${res.status} fetching ${startUrl}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const { bytes, truncated: byteTruncated } = await readBodyCapped(res, maxBytes);
  const text = opts.raw
    ? decodeCharset(bytes, contentType)
    : await extractText(contentType, bytes, current, opts.readable);
  return byteTruncated ? `${text}\n…(response exceeded ${maxBytes} bytes and was truncated)` : text;
}

/** Whether `current` is on the same site as the crawl's base origin: identical
 * host + port, with an http→https UPGRADE tolerated (never a downgrade, never a
 * different host). Keeps a crawler on its own domain while surviving the near-
 * universal http→https redirect. Malformed URLs fail closed (not same-site). */
export function sameSite(current: string, baseOrigin: string): boolean {
  let cur: URL;
  let base: URL;
  try {
    cur = new URL(current);
    base = new URL(baseOrigin);
  } catch {
    return false;
  }
  if (cur.hostname !== base.hostname || cur.port !== base.port) return false;
  if (cur.protocol === base.protocol) return true;
  return base.protocol === "http:" && cur.protocol === "https:"; // upgrade only
}

/** The URL to actually connect to: the guard-verified IP (bracketed for IPv6)
 * when a hostname was resolved, else the original URL. */
function pinnedUrl(u: URL, pinnedIp?: string): string {
  if (!pinnedIp) return u.toString();
  const hostPart = isIP(pinnedIp) === 6 ? `[${pinnedIp}]` : pinnedIp;
  const port = u.port ? `:${u.port}` : "";
  // Preserve any embedded credentials (Basic auth) — dropping them would silently
  // break `http://user:pass@host/…`. The fragment is client-only (never sent), so
  // it's correctly omitted.
  const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ""}@` : "";
  return `${u.protocol}//${auth}${hostPart}${port}${u.pathname}${u.search}`;
}

/** A current, honest browser-like UA — many sites 403 a UA-less client, and an
 * obviously-fake UA gets bot-walled harder. Includes the tool name for operators
 * reading their logs. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 vibecodr";

/** Fetch init that preserves virtual-host routing + TLS identity when connecting
 * by a pinned IP: the original Host header, and (for HTTPS) the SNI/cert hostname
 * via Bun's `tls.serverName`, so cert validation still checks the real hostname. */
function pinnedInit(target: { url: URL; pinnedIp?: string }, signal: AbortSignal): RequestInit {
  const base = {
    signal,
    redirect: "manual" as const,
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/pdf,*/*" },
  };
  if (!target.pinnedIp) return base;
  const init = {
    ...base,
    headers: { ...base.headers, host: target.url.host },
  } as RequestInit & {
    tls?: { serverName: string };
  };
  if (target.url.protocol === "https:") init.tls = { serverName: target.url.hostname };
  return init;
}

/** Turn raw response bytes into readable text by content type: PDF → extracted
 * text; HTML → Readability-or-htmlToText; anything else → decoded verbatim. */
async function extractText(
  contentType: string,
  bytes: Uint8Array,
  url: string,
  injectedReadable: ReadableFn | undefined,
): Promise<string> {
  const isPdf =
    /application\/pdf/i.test(contentType) ||
    (bytes.length >= 5 && "%PDF-".split("").every((c, i) => bytes[i] === c.charCodeAt(0)));
  if (isPdf) {
    const pdf = extractPdfText(Buffer.from(bytes));
    if (!pdf) {
      throw new Error("PDF has no extractable text (likely scanned/encrypted) — find an HTML source.");
    }
    return `[PDF, ${pdf.pages} page${pdf.pages === 1 ? "" : "s"}]\n${pdf.text}`;
  }
  const body = decodeCharset(bytes, contentType);
  if (!contentType.includes("html")) return body;
  const readable = injectedReadable ?? (await loadReadable());
  return readable?.(body, url) ?? htmlToText(body);
}

/**
 * Decode response bytes honoring the declared charset — the Content-Type
 * `charset=` parameter first, then an HTML `<meta charset>` sniff of the head —
 * instead of assuming UTF-8 (which turned Shift-JIS / windows-1252 pages into
 * mojibake). An unknown label degrades to UTF-8, never throws.
 */
export function decodeCharset(bytes: Uint8Array, contentType: string): string {
  let label = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!label) {
    // Sniff the first 2KB (spec-sanctioned window) decoded as latin1 — charset
    // declarations are ASCII, so this is safe for finding the label.
    const head = new TextDecoder("latin1" as ConstructorParameters<typeof TextDecoder>[0]).decode(
      bytes.subarray(0, 2048),
    );
    label =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
      /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];
  }
  if (label && !/^utf-?8$/i.test(label)) {
    try {
      return new TextDecoder(
        label.toLowerCase() as ConstructorParameters<typeof TextDecoder>[0],
        { fatal: false },
      ).decode(bytes);
    } catch {
      /* unknown label — fall through to UTF-8 */
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
