/**
 * Native search intelligence — canonical-URL dedup, source classification,
 * quality ranking, and quotable-passage extraction. Pure string/URL processing,
 * no external services or processes; the engines that feed it live in
 * search-engines.ts and the fan-out/merge composition lives in web-search.ts.
 *
 * Ported from the agentswarm research stack (itself from the author's SearchKit),
 * kept dependency-free so it stays headless-testable.
 */

export interface Passage {
  text: string;
  score: number;
}

export type SourceType = "primary" | "government" | "academic" | "news" | "social" | "secondary";

/** Lowercased alphanumeric query tokens, stopword-ish short tokens dropped. */
export function queryTerms(query: string): string[] {
  const m = query.toLowerCase().match(/[a-z0-9]+/g) || [];
  return [...new Set(m.filter((t) => t.length > 2))];
}

/**
 * Generate complementary query phrasings to widen source coverage: the
 * original, a stopword-stripped keyword core (different recall on most engines),
 * a docs/guide angle for question-shaped queries, a quoted phrase variant for
 * precision, and recency-boosted variants. Deterministic and low-noise, capped at `max`.
 */
export function expandQueries(query: string, max = 6): string[] {
  const base = query.trim();
  const out = [base];
  const terms = queryTerms(query);
  const core = terms.join(" ");
  const isQuestion = /^(how|what|why|when|which|where|who|is|are|can|does|do)\b/i.test(base);

  if (core && core.length > 4 && core !== base.toLowerCase()) out.push(core);
  if (isQuestion && terms.length) {
    out.push(`${core} guide`);
    if (core && terms.length >= 2) out.push(`"${core}"`);
    if (!/\b(19|20)\d{2}\b|year|date|when|time/.test(base.toLowerCase())) {
      // Bias toward the CURRENT and prior year (computed, not hardcoded — a fixed
      // "2024 OR 2025" would silently rot and omit the present year going forward).
      const y = new Date().getUTCFullYear();
      out.push(`${core} ${y - 1} OR ${y}`);
    }
  }
  const seen = new Set<string>();
  return out
    .map((q) => q.trim())
    .filter((q) => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()))
    .slice(0, max);
}

/**
 * Fallback phrasing when a query returns nothing: strip quotes and search
 * operators down to the top keyword terms. Returns "" when no useful
 * simplification exists.
 */
export function reformulate(query: string): string {
  const cleaned = query
    .replace(/["'“”‘’]/g, " ")
    .replace(/\b(site|intitle|inurl|filetype):\S+/gi, " ");
  const alt = queryTerms(cleaned).slice(0, 6).join(" ");
  return alt && alt !== query.toLowerCase().trim() ? alt : "";
}

const TRACKING_KEYS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);

/** Stable canonical form for dedup: strip tracking params, www, trailing slash; sort the query. */
export function canonicalizeUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url.toLowerCase();
  }
  const pairs = [...u.searchParams.entries()].filter(
    ([k]) => !TRACKING_KEYS.has(k.toLowerCase()) && !k.toLowerCase().startsWith("utm_"),
  );
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = pairs.length ? `?${pairs.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  let path = u.pathname || "/";
  if (path !== "/") path = path.replace(/\/+$/, "");
  return `${u.protocol.toLowerCase()}//${host}${path}${query}`;
}

const ACADEMIC_HOSTS = [
  "arxiv.org",
  "doi.org",
  "semanticscholar.org",
  "ncbi.nlm.nih.gov",
  "nature.com",
  "sciencedirect.com",
  "springer.com",
  "link.springer.com",
  "scholar.google.com",
  "acm.org",
  "ieee.org",
];

/**
 * Authoritative primary-source publishers that don't fall under .gov/.edu:
 * IGOs, official statistics agencies, central banks, registries — the sources a
 * research engine should up-rank hardest.
 */
const PRIMARY_HOSTS = [
  "who.int",
  "un.org",
  "imf.org",
  "worldbank.org",
  "oecd.org",
  "wto.org",
  "europa.eu",
  "iea.org",
  "bis.org",
  "ilo.org",
  "fao.org",
  "clinicaltrials.gov",
  "sec.gov",
  "federalregister.gov",
];

/** Non-US government TLD patterns that `.gov`/`.mil` alone miss. */
const GOV_SUFFIXES = [".gov", ".mil", ".gov.uk", ".gov.au", ".gc.ca", ".go.jp", ".gouv.fr"];

export function classifySource(domain: string): SourceType {
  const d = domain.toLowerCase();
  if (PRIMARY_HOSTS.some((h) => d === h || d.endsWith(`.${h}`))) return "primary";
  if (GOV_SUFFIXES.some((s) => d.endsWith(s))) return "government";
  if (d.endsWith(".edu")) return "academic";
  if (ACADEMIC_HOSTS.some((h) => d === h || d.endsWith(`.${h}`))) return "academic";
  if (["twitter.com", "x.com", "reddit.com", "facebook.com"].some((s) => d.includes(s))) return "social";
  if (d.includes("news") || d.includes("reuters.com") || d.includes("apnews.com") || d.includes("bbc.")) return "news";
  return "secondary";
}

/** Recency boost from an ISO date or bare year: +3 <1y, +2 <2y, +1 <5y, 0 older/undated. */
export function freshnessBoost(date: string | undefined, now = Date.now()): number {
  if (!date) return 0;
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/.exec(date.trim());
  if (!m) return 0;
  const t = Date.UTC(Number(m[1]), m[2] ? Number(m[2]) - 1 : 6, m[3] ? Number(m[3]) : 15);
  const years = (now - t) / 31_557_600_000;
  // A future-dated result (a typo year like 2099, or a clock skew) is not
  // "fresh" — don't award it the max boost; treat it as undated.
  if (years < 0) return 0;
  if (years < 1) return 3;
  if (years < 2) return 2;
  if (years < 5) return 1;
  return 0;
}

// A cue word immediately before a bare year signals it's a publish/update
// date, not an in-body reference ("unchanged since 2016"). `©` handled apart
// since it isn't a word char. `on`/`date` are word-bounded so "comparison"
// doesn't leak an "on".
const DATE_CUE = /(?:\b(?:published|updated|posted|revised|on|dated?|date)\b|©)/i;
// How far back to look for that cue, and how far into the text a bare year may
// sit and still read as a dateline (must stay under the position of a mid-text
// distractor year so those don't earn a freshness boost).
const CUE_LOOKBEHIND = 24;
const DATELINE_HEAD = 12;

/** ISO date if present (with a sane month 01-12 / day 01-31 — so `2025-13-45`
 * isn't silently normalized into a bogus date), else a bare year — but only a
 * year that sits at the head of the text or right after a date cue, so an
 * in-body mention ("unchanged since 2016") doesn't masquerade as the date. */
export function detectDate(text: string): string | undefined {
  for (const m of text.matchAll(/\b20\d{2}-(\d{2})-(\d{2})\b/g)) {
    const mo = Number(m[1]);
    const day = Number(m[2]);
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) return m[0];
  }
  for (const m of text.matchAll(/\b(20\d{2})\b/g)) {
    const idx = m.index!;
    if (idx <= DATELINE_HEAD) return m[1];
    if (DATE_CUE.test(text.slice(Math.max(0, idx - CUE_LOOKBEHIND), idx))) return m[1];
  }
  return undefined;
}

const WINDOW_WORDS = 60;
const STRIDE = 30;

/**
 * Quotable passages: slide a 60-word window (stride 30) over the text and score
 * each window by the fraction of query terms it contains. Deterministic lexical
 * matching — no embeddings. Falls back to the lead window so a hit always carries
 * something quotable.
 */
export function selectPassages(text: string, query: string, maxPassages = 3): Passage[] {
  const body = text.trim();
  if (!body) return [];
  const terms = queryTerms(query);
  const tokens = [...body.matchAll(/\S+/g)];
  if (!tokens.length) return [];

  const windows: Passage[] = [];
  for (let i = 0; i < tokens.length; i += STRIDE) {
    const slice = tokens.slice(i, i + WINDOW_WORDS);
    const start = slice[0]!.index!;
    const last = slice[slice.length - 1]!;
    const chunk = body.slice(start, last.index! + last[0].length);
    windows.push({ text: chunk, score: scoreChunk(chunk, terms) });
    if (i + WINDOW_WORDS >= tokens.length) break;
  }

  const scored = windows.filter((w) => w.score > 0).sort((a, b) => b.score - a.score);
  const picked = (scored.length ? scored : windows).slice(0, maxPassages);
  return picked.map((p) => ({ text: p.text, score: Math.round(p.score * 10_000) / 10_000 }));
}

function scoreChunk(chunk: string, terms: string[]): number {
  if (!terms.length) return 0;
  const lowered = chunk.toLowerCase();
  let hits = 0;
  for (const t of terms) if (lowered.includes(t)) hits++;
  return hits / terms.length;
}

export interface PageSignal {
  url: string;
  domain: string;
  title: string;
  text: string;
  date?: string;
}

/** Content-quality score for a fetched page (deep-mode re-ranking). */
export function scorePage(page: PageSignal, terms: string[]): number {
  let score = 0;
  // Strip a leading `www.` so the exact-host boosts/penalties below apply to
  // `www.github.com` / `www.npmjs.com` too (safeHost keeps the www prefix). Only
  // strip when another label follows, so a real domain like `www.com`/`www.io`
  // isn't mangled to a bare TLD.
  const domain = page.domain.toLowerCase().replace(/^www\.(?=.*\.)/, "");
  const url = page.url.toLowerCase();
  const title = page.title.toLowerCase();
  const type = classifySource(domain);
  if (type === "primary" || type === "government" || type === "academic") score += 5;
  if (domain.includes("docs") || url.includes("docs") || title.includes("documentation")) score += 5;
  if (domain === "github.com" || domain === "gitlab.com") score += 4;
  if (["pypi.org", "npmjs.com", "rubygems.org"].includes(domain)) score -= 2;
  score += freshnessBoost(page.date);
  const lowered = page.text.toLowerCase();
  for (const t of terms) if (lowered.includes(t)) score += 1;
  score += Math.min(page.text.length / 4000, 1);
  return score;
}

export interface Candidate {
  title: string;
  url: string;
  snippet: string;
  /** Position within its engine's result list (1-based). */
  rank: number;
  engine: string;
  date?: string;
}

const LOW_VALUE_SNIPPET = ["copy a direct link", "file metadata"];

/** Pre-fetch quality score for one engine result (snippet-level signals only). */
export function resultQualityScore(c: Candidate): number {
  const url = c.url.toLowerCase();
  const title = c.title.toLowerCase();
  const snippet = c.snippet.toLowerCase();
  let score = Math.max(0, 20 - c.rank);
  if (title.includes("official") || snippet.includes("official")) score += 4;
  if (title.includes("documentation") || snippet.includes("documentation") || url.includes("docs")) score += 4;
  if (url.includes("github.com") || url.includes("gitlab.com")) score += 3;
  if (c.engine === "arxiv" || c.engine === "crossref") score += 3;
  score += Math.min(2, freshnessBoost(c.date));
  if (LOW_VALUE_SNIPPET.some((t) => snippet.includes(t))) score -= 10;
  return score;
}

/**
 * Merge results from several engines: quality-rank, dedupe by canonical URL
 * (first/best occurrence wins), cap at maxResults.
 */
export function mergeCandidates(candidates: Candidate[], maxResults: number): Candidate[] {
  const ranked = [...candidates].sort((a, b) => resultQualityScore(b) - resultQualityScore(a));
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of ranked) {
    const key = canonicalizeUrl(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= maxResults) break;
  }
  return out;
}

/** Best-passage bonus used in deep-mode composite scoring. */
export function passageBonus(passages: Passage[]): number {
  return passages.length ? passages[0]!.score * 3 : 0;
}
