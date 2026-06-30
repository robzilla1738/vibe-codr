import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

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

/** Crude HTML -> text: strip scripts/styles/tags, collapse whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const webfetchTool: ToolDefinition<z.infer<typeof Input>> = {
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
    try {
      const res = await fetch(url, { signal: ctx.abortSignal });
      if (!res.ok) {
        return { output: `HTTP ${res.status} fetching ${url}`, isError: true };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();
      const text = contentType.includes("html") ? htmlToText(body) : body;
      const cap = maxChars ?? DEFAULT_MAX_CHARS;
      // Truncate only past the model-chosen limit, and say how much was dropped
      // so it can re-fetch with a larger `maxChars` if it needs the rest.
      const capped =
        text.length > cap
          ? `${text.slice(0, cap)}\n…(truncated ${text.length - cap} more chars; raise maxChars to read further)`
          : text;
      return { output: capped };
    } catch (err) {
      return { output: `Fetch failed: ${(err as Error).message}`, isError: true };
    }
  },
};
