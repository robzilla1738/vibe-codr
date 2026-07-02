import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";
import type { FetchPolicy, Lookup } from "./net-guard.ts";
import { guardedFetchText, htmlToText } from "./webfetch.ts";
import { canonicalizeUrl, selectPassages } from "./searchcore.ts";

const Input = z.object({
  url: z.string().url().describe("The docs page to start from (its domain bounds the crawl)."),
  query: z
    .string()
    .min(1)
    .describe("What you're looking for — pages are ranked and excerpted against this."),
  maxPages: z
    .number()
    .int()
    .positive()
    .max(15)
    .optional()
    .describe("Page budget (default 10, max 15)."),
});

const DEFAULT_MAX_PAGES = 10;
const MAX_DEPTH = 2;
/** Byte cap per page — docs pages, not downloads. */
const PAGE_BYTES = 512_000;
/** Total char budget for the rendered result (context-tool cap invariant). */
const OUTPUT_BUDGET = 24_000;

/** Link/path noise that never contains documentation content. */
const SKIP_PATH =
  /\.(png|jpe?g|gif|svg|ico|css|js|woff2?|ttf|zip|tar|gz|mp4|webm)(\?|#|$)|\/(login|signup|signin|cart|pricing\/?$)/i;

/** Extract same-origin links from raw HTML, resolved against the page URL. */
export function extractLinks(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin;
  const out = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
    const href = m[1];
    // Pure-fragment links are same-page anchors; others get their hash stripped below.
    if (!href || href.startsWith("#") || /^(mailto:|javascript:|tel:)/i.test(href)) continue;
    try {
      const abs = new URL(href, pageUrl);
      if (abs.origin !== origin || SKIP_PATH.test(abs.pathname + abs.search)) continue;
      abs.hash = "";
      out.add(abs.toString());
    } catch {
      /* malformed href — skip */
    }
  }
  return [...out];
}

export interface CrawlDocsOptions {
  policy?: FetchPolicy;
  lookup?: Lookup;
  /** Injectable page fetcher (tests). Must return RAW html/text. */
  fetchPage?: (url: string, signal: AbortSignal) => Promise<string>;
  /** Per-crawl wall clock (ms). Default 30s. */
  timeoutMs?: number;
}

/**
 * Bounded same-domain BFS over a documentation site: fetch the start page,
 * follow same-origin links breadth-first (depth ≤ 2, page budget ≤ 15), score
 * each page's text against the query, and return the best pages with quotable
 * excerpts — the keyless "read a whole docs site" capability. Every fetch runs
 * through the hardened SSRF-pinned pipeline.
 */
export function crawlDocsTool(opts: CrawlDocsOptions = {}): ToolDefinition<z.infer<typeof Input>> {
  return {
    name: "crawl_docs",
    description:
      "Crawl a documentation site (same domain only, breadth-first, bounded) and return the pages " +
      "most relevant to your query with quotable excerpts. Use when the answer is spread across a " +
      "docs site and one webfetch isn't enough — e.g. 'how do I configure X' across a framework's " +
      "guide. Prefer a specific starting page (the docs root or a section) over the site home page.",
    inputSchema: Input,
    readOnly: true,
    network: true,
    concurrencySafe: true,
    async execute({ url, query, maxPages }, ctx) {
      const budget = Math.min(maxPages ?? DEFAULT_MAX_PAGES, 15);
      const signal = AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(opts.timeoutMs ?? 30_000)]);
      // The crawl is bounded to the start page's origin (extractLinks only
      // enqueues same-origin links); pin that same origin THROUGH redirects so a
      // server-side redirect to an external host can't escape the crawl scope and
      // have its content stored under a trusted docs URL.
      const crawlOrigin = new URL(url).origin;
      const fetchPage =
        opts.fetchPage ??
        ((u: string, s: AbortSignal) =>
          guardedFetchText(u, {
            signal: s,
            maxBytes: PAGE_BYTES,
            raw: true,
            sameOrigin: crawlOrigin,
            ...(opts.policy ? { policy: opts.policy } : {}),
            ...(opts.lookup ? { lookup: opts.lookup } : {}),
          }));

      const seen = new Set<string>([canonicalizeUrl(url)]);
      const queue: { url: string; depth: number }[] = [{ url, depth: 0 }];
      const pages: { url: string; text: string; score: number; excerpts: string[] }[] = [];
      const errors: string[] = [];

      while (queue.length && pages.length + errors.length < budget) {
        if (signal.aborted) break;
        const next = queue.shift();
        if (!next) break;
        let html: string;
        try {
          html = await fetchPage(next.url, signal);
        } catch (err) {
          errors.push(`${next.url}: ${(err as Error).message}`);
          continue;
        }
        const text = htmlToText(html);
        const passages = selectPassages(text, query, 3);
        pages.push({
          url: next.url,
          text,
          score: passages[0]?.score ?? 0,
          excerpts: passages.map((p) => p.text),
        });
        if (next.depth < MAX_DEPTH) {
          for (const link of extractLinks(html, next.url)) {
            const key = canonicalizeUrl(link);
            if (seen.has(key)) continue;
            seen.add(key);
            queue.push({ url: link, depth: next.depth + 1 });
          }
        }
      }

      if (!pages.length) {
        return {
          output: `Crawl of ${url} found no readable pages${errors.length ? ` (${errors.length} fetch failures; first: ${errors[0]})` : ""}.`,
          isError: true,
        };
      }

      // Most relevant pages first; render within the output budget.
      pages.sort((a, b) => b.score - a.score);
      let remaining = OUTPUT_BUDGET;
      const blocks: string[] = [];
      let shown = 0;
      for (const p of pages) {
        if (p.score === 0 && shown > 0) continue; // irrelevant page — skip unless it's all we have
        const excerpt = p.excerpts
          .map((e) => `  > ${e.replace(/\s+/g, " ").trim().slice(0, 400)}`)
          .join("\n");
        const block = `${p.url}\n${excerpt || `  ${p.text.slice(0, 300)}`}`;
        if (block.length > remaining) break;
        remaining -= block.length;
        blocks.push(block);
        shown++;
      }
      const skipped = pages.length - shown;
      return {
        output:
          `Crawled ${pages.length} page(s) from ${new URL(url).origin} — most relevant to "${query}":\n\n` +
          blocks.join("\n\n") +
          (skipped > 0 ? `\n\n…(${skipped} less-relevant page(s) omitted)` : "") +
          (errors.length ? `\n(${errors.length} page(s) failed to fetch)` : ""),
      };
    },
  };
}
