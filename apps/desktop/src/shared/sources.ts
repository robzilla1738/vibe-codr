import { safeExternalUrl } from "./external-url";

export interface SourceItem {
  title: string;
  url?: string;
  domain?: string;
  snippet?: string;
}

function stripBullet(line: string): string {
  return line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "").trim();
}

export function hostOf(url: string): string {
  const match = /^(?:[a-z]+:\/\/)?(?:www\.)?([^/\s?#]+)/i.exec(url.trim());
  return match?.[1] ?? "";
}

/** Parse the CLI's `sources` fenced-block formats into presentation cards. */
export function parseSources(body: string): SourceItem[] {
  const sources: SourceItem[] = [];
  for (const raw of body.split("\n")) {
    const line = stripBullet(raw);
    if (!line) continue;
    if (line.includes("|")) {
      const [title, domain, snippet] = line.split("|").map((part) => part.trim());
      sources.push({
        title: title || "(untitled)",
        domain: domain || undefined,
        snippet: snippet || undefined,
        url: domain && /\./.test(domain) ? domain : undefined,
      });
      continue;
    }
    const link = /\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/.exec(line);
    if (link) {
      const url = link[2]!.trim();
      sources.push({
        title: link[1]!.trim(),
        url,
        domain: hostOf(url) || undefined,
        snippet: link[3]!.replace(/^[\s—–:-]+/, "").trim() || undefined,
      });
      continue;
    }
    const bare = /(https?:\/\/\S+)/i.exec(line);
    if (bare) {
      const url = bare[1]!;
      sources.push({
        title: line.slice(0, bare.index).replace(/[\s—–:-]+$/, "").trim() || hostOf(url),
        url,
        domain: hostOf(url) || undefined,
        snippet: line.slice(bare.index + url.length).replace(/^[\s—–:-]+/, "").trim() || undefined,
      });
      continue;
    }
    sources.push({ title: line });
  }
  return sources;
}

/** Parse numbered raw `web_search` output, matching the TUI source treatment. */
export function parseSearchResults(text: string): SourceItem[] {
  const sources: SourceItem[] = [];
  let current: SourceItem | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (current) sources.push(current);
      current = { title: numbered[1]!.replace(/\s+,/g, ",").trim() };
      continue;
    }
    if (!current) continue;
    const url = /^(https?:\/\/\S+)$/i.exec(line);
    if (url && !current.url) {
      current.url = url[1]!;
      current.domain = hostOf(url[1]!) || undefined;
      continue;
    }
    current.snippet = current.snippet ? `${current.snippet} ${line}` : line;
  }
  if (current) sources.push(current);
  return sources;
}

export function externalHref(url: string | undefined): string | null {
  if (!url) return null;
  const href = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
  return safeExternalUrl(href);
}
