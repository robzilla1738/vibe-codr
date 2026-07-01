import { z } from "zod";
import { isIP } from "node:net";
import type { ToolDefinition } from "@vibe/shared";
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

/** HTML -> readable text: drop comments, scripts/styles, and head/nav/footer
 * boilerplate, strip remaining tags, decode entities, collapse whitespace. This
 * is the always-available fallback when Readability isn't installed. */
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
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
          const article = new readability.Readability(document).parse();
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
 * whether the body was truncated at the cap. */
async function readCappedBytes(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > maxBytes
      ? { bytes: buf.subarray(0, maxBytes), truncated: true }
      : { bytes: buf, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.length > maxBytes) {
      const room = Math.max(0, maxBytes - total);
      if (room) chunks.push(value.subarray(0, room));
      total += room;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return { bytes: buf, truncated };
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
    concurrencySafe: true,
    async execute({ url, maxChars }, ctx) {
      const signal = AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(timeoutMs)]);

      // The full extracted text (pre-char-cap) for one URL. Throws on any fetch
      // failure so the cache can serve a stale copy; the SSRF guard runs INSIDE
      // (re-checked per redirect hop) so a block is never bypassed by the cache.
      const fetchAndExtract = async (): Promise<string> => {
        let current = url;
        let res: Response | undefined;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          const target = await assertFetchAllowed(current, policy, opts.lookup);
          // Connect to the exact IP the guard verified (when it resolved a
          // hostname), keeping the original Host header + TLS SNI, so a DNS rebind
          // can't point the actual connection at a private address. IP-literal /
          // opted-in targets have no pinnedIp and fetch the URL as-is.
          const r = await fetch(pinnedUrl(target.url, target.pinnedIp), pinnedInit(target, signal));
          const location = r.headers.get("location");
          if (r.status >= 300 && r.status < 400 && location) {
            await r.body?.cancel?.().catch(() => {});
            current = new URL(location, current).toString();
            continue;
          }
          res = r;
          break;
        }
        if (!res) throw new Error(`Too many redirects fetching ${url}`);
        if (!res.ok) {
          await res.body?.cancel?.().catch(() => {});
          throw new Error(`HTTP ${res.status} fetching ${url}`);
        }
        const contentType = res.headers.get("content-type") ?? "";
        const { bytes, truncated: byteTruncated } = await readCappedBytes(res, maxBytes);
        const text = await extractText(contentType, bytes, current, opts.readable);
        return byteTruncated
          ? `${text}\n…(response exceeded ${maxBytes} bytes and was truncated)`
          : text;
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

/** Fetch init that preserves virtual-host routing + TLS identity when connecting
 * by a pinned IP: the original Host header, and (for HTTPS) the SNI/cert hostname
 * via Bun's `tls.serverName`, so cert validation still checks the real hostname. */
function pinnedInit(target: { url: URL; pinnedIp?: string }, signal: AbortSignal): RequestInit {
  const base = { signal, redirect: "manual" as const };
  if (!target.pinnedIp) return base;
  const init = { ...base, headers: { host: target.url.host } } as RequestInit & {
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
  const body = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!contentType.includes("html")) return body;
  const readable = injectedReadable ?? (await loadReadable());
  return readable?.(body, url) ?? htmlToText(body);
}
