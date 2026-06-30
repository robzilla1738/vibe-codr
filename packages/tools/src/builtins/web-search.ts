import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";
import {
  duckDuckGoSearch,
  createCooldown,
  type SearchResult as EngineResult,
  type FetchLike,
} from "./search-engines.ts";

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
      "Keep only the top N of the provider's ranked results. Omit to keep them " +
        "all (the default); set a small N for a quick fact to stay tight. One " +
        "good query usually answers a quick fact — only issue another query when " +
        "you're genuinely researching a broad topic.",
    ),
});

type SearchResult = EngineResult;

const ENDPOINT = "https://api.search.tinyfish.ai";

export interface WebSearchOptions {
  /** TinyFish API key. Falls back to `TINYFISH_API_KEY` at call time. */
  apiKey?: string;
  /** Injectable fetch for the keyless engine (tests). */
  fetchImpl?: FetchLike;
}

/** Shared per-engine cooldown so a transiently blocking engine is skipped. */
const cooldown = createCooldown();

/**
 * Web search with a KEYLESS default. DuckDuckGo's HTML endpoint works with no API
 * key, so `web_search` always functions; TinyFish (free key from
 * agent.tinyfish.ai) is an optional higher-quality booster tried first when a key
 * is configured. Whichever engine returns results wins; the other is the fallback.
 */
export function webSearchTool(opts: WebSearchOptions = {}): ToolDefinition<z.infer<typeof Input>> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    name: "web_search",
    description:
      "Search the web for current information and return ranked results " +
      "(title, URL, snippet). Use for anything beyond the workspace or your " +
      "training cutoff. The snippets often already contain the answer (prices, " +
      "dates, version numbers) — read them first and answer from them; only " +
      "`webfetch` a result when its snippet isn't enough. One good query usually " +
      "settles a quick fact — don't reflexively re-search; reserve extra queries " +
      "for genuinely broad research. Use `recencyDays` for fast-moving topics.",
    inputSchema: Input,
    readOnly: true,
    concurrencySafe: true,
    async execute({ query, recencyDays, maxResults }, ctx) {
      const signal = AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(8000)]);
      const apiKey = process.env.TINYFISH_API_KEY ?? opts.apiKey;
      const now = Date.now();
      const errors: string[] = [];

      // Engines in priority order: TinyFish (if a key is set) then keyless DDG.
      const engines: { name: string; run: () => Promise<SearchResult[]> }[] = [];
      if (apiKey) {
        engines.push({ name: "tinyfish", run: () => tinyFishSearch(query, recencyDays, apiKey, fetchImpl, signal) });
      }
      engines.push({
        name: "duckduckgo",
        run: () => duckDuckGoSearch(query, { ...(recencyDays !== undefined ? { recencyDays } : {}) }, fetchImpl, signal),
      });

      for (const engine of engines) {
        if (cooldown.blocked(engine.name, now)) continue;
        try {
          const all = await engine.run();
          const results = maxResults ? all.slice(0, maxResults) : all;
          if (results.length) return { output: formatResults(query, results) };
        } catch (err) {
          if (ctx.abortSignal.aborted) return { output: "Search aborted." };
          const msg = (err as Error).message;
          if (/\b(429|403|503)\b/.test(msg)) cooldown.trip(engine.name, now);
          errors.push(`${engine.name}: ${msg}`);
        }
      }
      if (errors.length) {
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
): Promise<SearchResult[]> {
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
  const data = JSON.parse(await res.text()) as { results?: SearchResult[] };
  return data.results ?? [];
}

/** Render results as a markdown numbered list (title / URL / snippet) — clean for
 * the model AND nicely indented when the TUI renders it as markdown (the list
 * structure keeps each result's URL + snippet aligned, even when wrapped). */
export function formatResults(query: string, results: SearchResult[]): string {
  const items = results.map(
    (r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ").trim()}`,
  );
  return `Search results for "${query}"\n\n${items.join("\n\n")}`;
}
