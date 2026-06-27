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
const MAX_RESULTS = 8;

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
      "training cutoff; follow up with `webfetch` to read a result in full.",
    inputSchema: Input,
    readOnly: true,
    concurrencySafe: true,
    async execute({ query, recencyDays }, ctx) {
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
        const results = (data.results ?? []).slice(0, MAX_RESULTS);
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

/** Render results as a compact, model-friendly numbered list. */
export function formatResults(query: string, results: SearchResult[]): string {
  const lines = results.map(
    (r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ").trim()}`,
  );
  return `Search results for "${query}":\n\n${lines.join("\n\n")}`;
}
