import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";
import { assertFetchAllowed, type FetchPolicy, type Lookup } from "./net-guard.ts";

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
 * boilerplate, strip remaining tags, decode entities, collapse whitespace. */
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

/** Read a response body up to `maxBytes`, decoding as UTF-8. Returns the text
 * and whether the body was truncated at the byte cap. */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: await res.text(), truncated: false };
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
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(buf), truncated };
}

export interface WebfetchOptions extends FetchPolicy {
  /** Wall-clock cap per fetch (ms). Default 8000. */
  timeoutMs?: number;
  /** Byte ceiling pulled off the wire before the char cap. Default 4MB. */
  maxBytes?: number;
  /** Injectable DNS lookup for the SSRF guard (tests). */
  lookup?: Lookup;
}

/**
 * Fetch a URL and reduce it to text — hardened: an SSRF allowlist (no
 * loopback/link-local/metadata/private hosts by default), redirects followed
 * manually so every hop is re-validated, a wall-clock timeout, and a streaming
 * byte cap so an unbounded response can't hang the turn or OOM the process.
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
      "Fetch a URL and return its text content (HTML is reduced to plain text). " +
      "Use when you need the full page — a `web_search` snippet wasn't enough, or " +
      "you have a specific URL (docs, changelog, raw file) to read in full. Control " +
      "how much comes back with `maxChars`.",
    inputSchema: Input,
    readOnly: true,
    concurrencySafe: true,
    async execute({ url, maxChars }, ctx) {
      const signal = AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(timeoutMs)]);
      try {
        let current = url;
        let res: Response | undefined;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          // Re-validate every hop, so a benign URL can't redirect into the
          // metadata service or an internal host.
          await assertFetchAllowed(current, policy, opts.lookup);
          const r = await fetch(current, { signal, redirect: "manual" });
          const location = r.headers.get("location");
          if (r.status >= 300 && r.status < 400 && location) {
            await r.body?.cancel?.().catch(() => {});
            current = new URL(location, current).toString();
            continue;
          }
          res = r;
          break;
        }
        if (!res) return { output: `Too many redirects fetching ${url}`, isError: true };
        if (!res.ok) {
          await res.body?.cancel?.().catch(() => {});
          return { output: `HTTP ${res.status} fetching ${url}`, isError: true };
        }
        const contentType = res.headers.get("content-type") ?? "";
        const { text: body, truncated: byteTruncated } = await readCapped(res, maxBytes);
        const text = contentType.includes("html") ? htmlToText(body) : body;
        const cap = maxChars ?? DEFAULT_MAX_CHARS;
        if (text.length > cap) {
          return {
            output: `${text.slice(0, cap)}\n…(truncated ${text.length - cap} more chars; raise maxChars to read further)`,
          };
        }
        return {
          output: byteTruncated
            ? `${text}\n…(response exceeded ${maxBytes} bytes and was truncated)`
            : text,
        };
      } catch (err) {
        if (ctx.abortSignal.aborted) return { output: "Fetch aborted." };
        return { output: `Fetch failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}
