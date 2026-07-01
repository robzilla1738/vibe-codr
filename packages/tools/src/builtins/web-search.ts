import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";
import {
  duckDuckGoSearch,
  bingSearch,
  createCooldown,
  type SearchResult as EngineResult,
  type FetchLike,
} from "./search-engines.ts";
import { mergeCandidates, detectDate, expandQueries, type Candidate } from "./searchcore.ts";

const Input = z.object({
  query: z
    .string()
    .min(1)
    .describe("Search query. Supports operators like `site:domain.com`."),
  recencyDays: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Only return results from the last N days."),
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
    concurrencySafe: true,
    async execute({ query, recencyDays, maxResults, deep }, ctx) {
      const signal = AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(8000)]);
      const apiKey = process.env.TINYFISH_API_KEY ?? opts.apiKey;
      const now = Date.now();
      const engineOpts = recencyDays !== undefined ? { recencyDays } : {};

      // Keyless engines always run; TinyFish joins the pool when a key is set.
      const engines: Engine[] = [
        { name: "duckduckgo", run: (q) => duckDuckGoSearch(q, engineOpts, fetchImpl, signal) },
        { name: "bing", run: (q) => bingSearch(q, engineOpts, fetchImpl, signal) },
      ];
      if (apiKey) {
        engines.unshift({ name: "tinyfish", run: (q) => tinyFishSearch(q, recencyDays, apiKey, fetchImpl, signal) });
      }

      // Fan out every (query × engine) pair concurrently; each settles to a
      // result set or a recorded error so one failure never sinks the batch.
      const queries = deep ? expandQueries(query) : [query];
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
      const settled = await Promise.all(runs);
      if (ctx.abortSignal.aborted) return { output: "Search aborted." };

      const candidates: Candidate[] = [];
      const errors: string[] = [];
      let anyAnswered = false;
      for (const s of settled) {
        if (s.results) {
          anyAnswered = true;
          for (const [i, r] of s.results.entries()) {
            candidates.push({
              title: r.title,
              url: r.url,
              snippet: r.snippet,
              rank: r.position || i + 1,
              engine: s.engine,
              ...(detectDate(r.snippet) ? { date: detectDate(r.snippet) } : {}),
            });
          }
        } else if (s.error) {
          if (/\b(429|403|503)\b/.test(s.error)) cooldown.trip(s.engine, now);
          errors.push(`${s.engine}: ${s.error}`);
        }
      }

      const merged = mergeCandidates(candidates, maxResults ?? DEFAULT_MAX);
      if (merged.length) return { output: formatResults(query, merged) };
      // Every engine erroring is a failure; an engine answering with an empty
      // set is a genuine "no results".
      if (!anyAnswered && errors.length) {
        return { output: `Search failed (${errors.join("; ")}).`, isError: true };
      }
      return { output: `No results for "${query}".` };
    },
  };
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
  const data = JSON.parse(await res.text()) as { results?: EngineResult[] };
  return data.results ?? [];
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
