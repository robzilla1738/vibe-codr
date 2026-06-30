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
        "all (the default); set a small N for a quick fact to stay tight. To " +
        "research more broadly, issue more queries rather than expecting more " +
        "results from one.",
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
      "dates, version numbers) — read them first and only `webfetch` a result " +
      "when its snippet isn't enough. `maxResults` trims to the top N (keep it " +
      "small for a quick fact; omit to keep all); for more breadth issue more " +
      "queries. Use `recencyDays` for fast-moving topics.",
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

      try {
        const res = await fetch(url, {
          headers: { "X-API-Key": apiKey },
          signal: ctx.abortSignal,
        });
        if (!res.ok) {
          const detail = res.status === 401 || res.status === 403
            ? " (check your TinyFish API key)"
            : "";
          return { output: `Search failed: HTTP ${res.status}${detail}`, isError: true };
        }
        const data = (await res.json()) as { results?: SearchResult[] };
        // Keep every ranked result the provider returned by default (no engine
        // throttle); `maxResults` only trims the list for a tighter quick-fact
        // read. The provider's page size is the natural upper bound — we can't
        // ask it for more than it returns, so breadth comes from more queries.
        const all = data.results ?? [];
        const results = maxResults ? all.slice(0, maxResults) : all;
        if (!results.length) {
          return { output: `No results for "${query}".` };
        }
        return { output: formatResults(query, results) };
      } catch (err) {
        if (ctx.abortSignal.aborted) return { output: "Search aborted." };
        return { output: `Search failed: ${(err as Error).message}`, isError: true };
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
