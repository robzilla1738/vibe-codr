import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";
import {
  duckDuckGoSearch,
  bingSearch,
  createCooldown,
  type SearchResult as EngineResult,
  type FetchLike,
} from "./search-engines.ts";
import {
  mergeCandidates,
  detectDate,
  expandQueries,
  reformulate,
  selectPassages,
  scorePage,
  passageBonus,
  queryTerms,
  type Candidate,
} from "./searchcore.ts";
import { guardedFetchText } from "./webfetch.ts";

const Input = z.object({
  query: z.string().min(1).describe("Search query. Supports operators like `site:domain.com`."),
  recencyDays: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Prefer results from roughly the last N days (best-effort, coarse — mapped " +
        "to each engine's native recency filter; not a hard post-filter, and some " +
        "engines only bucket by day/week/month/year).",
    ),
  maxResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Keep only the top N ranked/deduped results. Omit to keep the default top " +
        "set; set a small N for a quick fact to stay tight. One good query usually " +
        "answers a quick fact — only issue another query when you're genuinely " +
        "researching a broad topic.",
    ),
  deep: z
    .boolean()
    .optional()
    .describe(
      "Widen recall: fan the query into complementary phrasings across every " +
        "engine before ranking. Slower — reserve it for broad research, not quick facts.",
    ),
});

/** Default cap on merged results when the caller doesn't specify `maxResults`. */
const DEFAULT_MAX = 12;
const ENDPOINT = "https://api.search.tinyfish.ai";

export interface WebSearchOptions {
  /** TinyFish API key. Falls back to `TINYFISH_API_KEY` at call time. */
  apiKey?: string;
  /** Injectable fetch for the keyless engines (tests). */
  fetchImpl?: FetchLike;
  /** Injectable deep-mode page fetcher (tests). Defaults to the hardened
   * guardedFetchText pipeline (SSRF-pinned, byte-capped). */
  enrichFetch?: (url: string, signal: AbortSignal) => Promise<string>;
}

/** Shared per-engine cooldown so a transiently blocking engine is skipped. */
const cooldown = createCooldown();

/** Test hook: clear the shared engine cooldown so test order can't leak state. */
export function _resetSearchCooldown(): void {
  cooldown.clear();
}

/** One search engine: a name (for cooldown) + a runner over the shared fetch. */
interface Engine {
  name: string;
  run: (query: string) => Promise<EngineResult[]>;
}

/**
 * Web search with a KEYLESS default that **fans out across engines** (DuckDuckGo
 * + Bing, plus TinyFish when a key is configured), then **dedupes by canonical
 * URL and quality-ranks** the merged pool (searchcore). Running two scrapers in
 * parallel means a single engine's block or parse-break can't take web_search
 * dark, and the ranker surfaces official/docs/primary sources over noise.
 * `deep:true` also fans the query into complementary phrasings for broad recall.
 * The network fetch is injectable so tests stay hermetic.
 */
export function webSearchTool(opts: WebSearchOptions = {}): ToolDefinition<z.infer<typeof Input>> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    name: "web_search",
    description:
      "Search the web for current information and return ranked, deduped results " +
      "(title, URL, snippet) merged across multiple engines. Use for anything " +
      "beyond the workspace or your training cutoff. The snippets often already " +
      "contain the answer (prices, dates, version numbers) — read them first and " +
      "answer from them; only `webfetch` a result when its snippet isn't enough. " +
      "One good query usually settles a quick fact — reserve `deep:true` and extra " +
      "queries for genuinely broad research. Use `recencyDays` for fast-moving topics.",
    inputSchema: Input,
    readOnly: true,
    network: true,
    concurrencySafe: true,
    async execute({ query, recencyDays, maxResults, deep }, ctx) {
      const signal = AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(deep ? 20_000 : 8_000)]);
      const apiKey = process.env.TINYFISH_API_KEY ?? opts.apiKey;
      const now = Date.now();
      const engineOpts = recencyDays !== undefined ? { recencyDays } : {};

      // Keyless engines always run; TinyFish joins the pool when a key is set.
      const engines: Engine[] = [
        { name: "duckduckgo", run: (q) => duckDuckGoSearch(q, engineOpts, fetchImpl, signal) },
        { name: "bing", run: (q) => bingSearch(q, engineOpts, fetchImpl, signal) },
      ];
      if (apiKey) {
        engines.unshift({
          name: "tinyfish",
          run: (q) => tinyFishSearch(q, recencyDays, apiKey, fetchImpl, signal),
        });
      }

      // Fan out every (query × engine) pair concurrently; each settles to a
      // result set or a recorded error so one failure never sinks the batch.
      const runFanout = async (queries: string[]) => {
        const runs: Promise<{ engine: string; results?: EngineResult[]; error?: string }>[] = [];
        for (const q of queries) {
          for (const engine of engines) {
            if (cooldown.blocked(engine.name, now)) continue;
            runs.push(
              engine.run(q).then(
                (results) => ({ engine: engine.name, results }),
                (err) => ({ engine: engine.name, error: (err as Error).message }),
              ),
            );
          }
        }
        return Promise.all(runs);
      };

      const collect = (settled: { engine: string; results?: EngineResult[]; error?: string }[]) => {
        const candidates: Candidate[] = [];
        const errors: string[] = [];
        let anyAnswered = false;
        for (const s of settled) {
          if (s.results) {
            anyAnswered = true;
            for (const [i, r] of s.results.entries()) {
              const date = detectDate(r.snippet);
              candidates.push({
                title: r.title,
                url: r.url,
                snippet: r.snippet,
                rank: r.position || i + 1,
                engine: s.engine,
                ...(date ? { date } : {}),
              });
            }
          } else if (s.error) {
            if (/\b(429|403|503)\b/.test(s.error)) cooldown.trip(s.engine, now);
            errors.push(`${s.engine}: ${s.error}`);
          }
        }
        return { candidates, errors, anyAnswered };
      };

      let { candidates, errors, anyAnswered } = collect(
        await runFanout(deep ? expandQueries(query) : [query]),
      );
      if (!candidates.length && !errors.length && !anyAnswered) {
        return {
          output:
            "Search failed: all configured search engines are temporarily cooling down after recent failures.",
          isError: true,
        };
      }
      if (ctx.abortSignal.aborted) return { output: "Search aborted." };

      // Zero results with live engines → retry ONCE with the keyword core (a
      // quoted phrase or operator-heavy query often over-constrains recall).
      let reformulatedTo: string | undefined;
      if (!candidates.length && anyAnswered) {
        const alt = reformulate(query);
        if (alt) {
          reformulatedTo = alt;
          const second = collect(await runFanout([alt]));
          if (!second.candidates.length && !second.errors.length && !second.anyAnswered) {
            return {
              output:
                "Search failed: all configured search engines are temporarily cooling down after recent failures.",
              isError: true,
            };
          }
          candidates = second.candidates;
          errors = errors.concat(second.errors);
          anyAnswered = anyAnswered || second.anyAnswered;
        }
      }

      const merged = mergeCandidates(candidates, maxResults ?? DEFAULT_MAX);
      const note = reformulatedTo
        ? `(no results for the original phrasing — reformulated to "${reformulatedTo}")\n`
        : "";
      if (merged.length && deep) {
        const enriched = await deepEnrich(query, merged, signal, opts.enrichFetch);
        if (ctx.abortSignal.aborted) return { output: "Search aborted." };
        return { output: `${note}${formatDeepResults(query, enriched)}` };
      }
      if (merged.length) return { output: `${note}${formatResults(query, merged)}` };
      // Every engine erroring is a failure; an engine answering with an empty
      // set is a genuine "no results".
      if (!anyAnswered && errors.length) {
        return { output: `Search failed (${errors.join("; ")}).`, isError: true };
      }
      return {
        output: `No results for "${query}"${reformulatedTo ? ` (also tried "${reformulatedTo}")` : ""}.`,
      };
    },
  };
}

/** How many top-ranked pages deep mode fetches for passage extraction. */
const DEEP_FETCH_PAGES = 8;
/** Byte cap per enrichment fetch — we want passages, not whole sites. */
const DEEP_FETCH_BYTES = 512_000;

interface EnrichedCandidate extends Candidate {
  passages?: string[];
}

/** A bare github repo URL serves its content via the README — fetch that raw
 * (10× less markup than the HTML page). */
function enrichmentUrl(url: string): string {
  const m = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?$/.exec(url);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/README.md` : url;
}

/**
 * Deep-mode enrichment (the research-quality differentiator): fetch the top
 * merged pages through the SAME hardened pipeline webfetch uses (SSRF-pinned,
 * byte-capped), extract dated query-scored quotable passages, and re-rank by
 * content quality — so a deep search returns groundable quotes, not just
 * snippets. Failures degrade per-page; a dead link simply keeps its snippet.
 */
async function deepEnrich(
  query: string,
  merged: Candidate[],
  signal: AbortSignal,
  enrichFetch?: (url: string, signal: AbortSignal) => Promise<string>,
): Promise<EnrichedCandidate[]> {
  const fetchPage =
    enrichFetch ??
    ((url: string, s: AbortSignal) =>
      guardedFetchText(url, { signal: s, maxBytes: DEEP_FETCH_BYTES }));
  const terms = queryTerms(query);
  const enriched = await Promise.all(
    merged
      .slice(0, DEEP_FETCH_PAGES)
      .map(async (c): Promise<EnrichedCandidate & { score: number }> => {
        try {
          const text = await fetchPage(enrichmentUrl(c.url), signal);
          const passages = selectPassages(text, query, 2).map((p) => p.text);
          const date = detectDate(text.slice(0, 4_000)) ?? c.date;
          const score =
            scorePage(
              {
                url: c.url,
                domain: safeHost(c.url),
                title: c.title,
                text,
                ...(date ? { date } : {}),
              },
              terms,
            ) + passageBonus(selectPassages(text, query, 1));
          return { ...c, ...(date ? { date } : {}), passages, score };
        } catch {
          return { ...c, score: 0 }; // page dead/blocked — keep the snippet-only entry
        }
      }),
  );
  const rest: (EnrichedCandidate & { score: number })[] = merged
    .slice(DEEP_FETCH_PAGES)
    .map((c) => ({ ...c, score: 0 }));
  return [...enriched, ...rest].sort((a, b) => b.score - a.score);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Render deep results: ranked entries with quotable passages as `> quote`
 * lines, so downstream claims can cite actual page content. */
export function formatDeepResults(query: string, results: EnrichedCandidate[]): string {
  const items = results.map((r, i) => {
    const head = `${i + 1}. ${r.title}${r.date ? ` (${r.date})` : ""}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ").trim()}`;
    const quotes = (r.passages ?? [])
      .map((p) => `   > ${p.replace(/\s+/g, " ").trim().slice(0, 500)}`)
      .join("\n");
    return quotes ? `${head}\n${quotes}` : head;
  });
  return `Deep search results for "${query}" (passages quoted from the pages themselves)\n\n${items.join("\n\n")}`;
}

/** TinyFish engine (the optional booster). Throws on HTTP error. */
async function tinyFishSearch(
  query: string,
  recencyDays: number | undefined,
  apiKey: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<EngineResult[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("query", query);
  if (recencyDays !== undefined) {
    url.searchParams.set("recency_minutes", String(recencyDays * 24 * 60));
  }
  const res = await fetchImpl(url.toString(), { headers: { "X-API-Key": apiKey }, signal });
  if (!res.ok) {
    const detail = res.status === 401 || res.status === 403 ? " (check your TinyFish API key)" : "";
    throw new Error(`HTTP ${res.status}${detail}`);
  }
  // BUG-095 / BUG-104: stream-cap TinyFish body before JSON.parse (same class
  // as search HTML) — never fully buffer a hostile multi-MB body first.
  const { readCappedResponseText } = await import("./search-engines.ts");
  const capped = await readCappedResponseText(res, 512_000);
  const data = JSON.parse(capped) as { results?: unknown };
  // TinyFish is an external, unvalidated engine, so sanitize FULLY — both the
  // container and every element. `?? []` only catches null/undefined; a truthy
  // non-array (an error-envelope 200 like `{"results":{"error":…}}`) or an array
  // whose entries omit `url`/`snippet` would reach `collect()`'s `.entries()`,
  // `detectDate(r.snippet)`, or `canonicalizeUrl(r.url)` and THROW synchronously
  // (outside the per-engine settle guard), sinking the whole fan-out and discarding
  // the keyless DDG+Bing results. Coerce each entry to the SearchResult shape
  // (strings, never undefined) and drop entries with no usable URL.
  const raw = Array.isArray(data.results) ? data.results : [];
  return raw.flatMap((r): EngineResult[] => {
    const e = r as Record<string, unknown>;
    const url = typeof e?.url === "string" ? e.url.trim() : "";
    if (!url) return [];
    return [
      {
        position: typeof e?.position === "number" ? e.position : 0,
        site_name: String(e?.site_name ?? ""),
        title: String(e?.title ?? ""),
        snippet: String(e?.snippet ?? ""),
        url,
      },
    ];
  });
}

/** Render results as a markdown numbered list (title / URL / snippet) — clean for
 * the model AND nicely indented when the TUI renders it as markdown. Accepts any
 * shape carrying title/url/snippet (engine results or merged candidates). */
export function formatResults(
  query: string,
  results: { title: string; url: string; snippet: string }[],
): string {
  const items = results.map(
    (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ").trim()}`,
  );
  return `Search results for "${query}"\n\n${items.join("\n\n")}`;
}
