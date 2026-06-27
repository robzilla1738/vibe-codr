import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

const Input = z.object({
  url: z.string().url().describe("URL to fetch."),
});

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
    "Fetch a URL and return its text content (HTML is reduced to plain text).",
  inputSchema: Input,
  readOnly: true,
  concurrencySafe: true,
  async execute({ url }, ctx) {
    try {
      const res = await fetch(url, { signal: ctx.abortSignal });
      if (!res.ok) {
        return { output: `HTTP ${res.status} fetching ${url}`, isError: true };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();
      const text = contentType.includes("html") ? htmlToText(body) : body;
      const capped = text.length > 20_000 ? `${text.slice(0, 20_000)}\n…(truncated)` : text;
      return { output: capped };
    } catch (err) {
      return { output: `Fetch failed: ${(err as Error).message}`, isError: true };
    }
  },
};
