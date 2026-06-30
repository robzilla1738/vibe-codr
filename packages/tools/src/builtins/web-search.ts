import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

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

/** One TinyFish search result. */
interface SearchResult {
  position: number;
  site_name: string;
  title: string;
  snippet: string;
  url: string;
}

const ENDPOINT = "https://api.search.tinyfish.ai";

export interface WebSearchOptions {
  /** TinyFish API key. Falls back to `TINYFISH_API_KEY` at call time. */
  apiKey?: string;
}

/**
 * Web search powered by TinyFish (free tier, no card — key from
 * agent.tinyfish.ai). A factory so the engine can bind the configured key; the
 * env var `TINYFISH_API_KEY` is honoured as a fallback.
 */
export function webSearchTool(opts: WebSearchOptions = {}): ToolDefinition<
  z.infer<typeof Input>
> {
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
      const apiKey = process.env.TINYFISH_API_KEY ?? opts.apiKey;
      if (!apiKey) {
        return {
          output:
            "Web search is unavailable: no TinyFish API key configured. Get a " +
            "free key at https://agent.tinyfish.ai/api-keys and set TINYFISH_API_KEY " +
            "or search.apiKey in config.",
          isError: true,
        };
      }

      const url = new URL(ENDPOINT);
      url.searchParams.set("query", query);
      if (recencyDays !== undefined) {
        url.searchParams.set("recency_minutes", String(recencyDays * 24 * 60));
      }

      // One fetch attempt with a wall-clock cap layered on the caller's abort, so
      // a stalled connection can't hang the turn. Returns the ranked results or
      // throws (HTTP errors carry a "Search failed: …" message for the catch).
      const attempt = async (): Promise<SearchResult[]> => {
        const res = await fetch(url, {
          headers: { "X-API-Key": apiKey },
          signal: AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(8000)]),
        });
        if (!res.ok) {
          const detail = res.status === 401 || res.status === 403
            ? " (check your TinyFish API key)"
            : "";
          throw new Error(`Search failed: HTTP ${res.status}${detail}`);
        }
        const data = (await res.json()) as { results?: SearchResult[] };
        return data.results ?? [];
      };

      try {
        // Keep every ranked result the provider returned by default (no engine
        // throttle); `maxResults` only trims the list for a tighter quick-fact read.
        let all = await attempt();
        // The provider occasionally returns a *transient* empty array for a query
        // that does have results. One cheap retry (~0.6s) absorbs that flake here,
        // rather than handing the model a false dead-end and making it burn a whole
        // slow reasoning step re-searching a reworded variant.
        if (!all.length && !ctx.abortSignal.aborted) {
          await new Promise((r) => setTimeout(r, 600));
          if (!ctx.abortSignal.aborted) all = await attempt();
        }
        const results = maxResults ? all.slice(0, maxResults) : all;
        if (!results.length) {
          return { output: `No results for "${query}".` };
        }
        return { output: formatResults(query, results) };
      } catch (err) {
        if (ctx.abortSignal.aborted) return { output: "Search aborted." };
        const msg = (err as Error).message;
        return {
          output: msg.startsWith("Search failed") ? msg : `Search failed: ${msg}`,
          isError: true,
        };
      }
    },
  };
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
