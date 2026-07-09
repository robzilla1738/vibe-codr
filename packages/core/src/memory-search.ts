import { chunkMarkdown } from "./chunk.ts";
import { rankBm25, reciprocalRankFusion, queryTerms, tokenize } from "./bm25.ts";
import { searchSessions } from "./recall.ts";
import type { SemanticMemory, MemoryDoc } from "./semantic-memory.ts";

/** One unified memory result — a saved note/fact or a past-session snippet. */
export interface MemoryHit {
  id: string;
  /** Originating file path (memory) or session id (session). */
  source: string;
  heading: string;
  text: string;
  kind: "memory" | "session";
  /** Fused relevance score (higher = more relevant). */
  score: number;
}

/**
 * Search mode:
 * - `explicit` (default): `/recall` + `recall_memory` — permissive, includes
 *   past-session transcripts, dense hits exempt from the lexical floor.
 * - `proactive`: session-start injection into the system prompt — stricter
 *   floors, no session-transcript fusion, dense hits need a min cosine so a
 *   weak nearest-neighbour cannot hijack the live turn.
 */
export type MemorySearchMode = "explicit" | "proactive";

export interface SearchMemoryOptions {
  cwd: string;
  query: string;
  /** The memory-markdown corpus (curated + saved facts), gathered by the caller. */
  sources: MemoryDoc[];
  /** Dense (semantic) layer; omitted when no embedder is available → lexical only. */
  semantic?: SemanticMemory;
  /** Also fuse lexical recall over past sessions (default true for explicit;
   * forced off for proactive — raw transcript snippets are too noisy to inject
   * into every turn's system prompt). */
  includeSessions?: boolean;
  limit?: number;
  /** Default `explicit`. Proactive uses a higher relevance bar. */
  mode?: MemorySearchMode;
  /**
   * Min cosine similarity for a dense hit to bypass the lexical floor under
   * proactive mode. Explicit mode ignores this (dense always exempt). Default
   * 0.38 — low enough for real paraphrases, high enough to drop weak neighbors.
   */
  minDenseCosine?: number;
}

/** Keep a hit only if its per-hit relevance is at least this fraction of the top
 * hit's — drops stragglers far weaker than a genuinely strong match. Low on
 * purpose: the overlap floor below does the junk-rejection; this only trims the
 * long tail. */
const FRACTION_OF_TOP = 0.25;
/** Proactive: require a stronger relative BM25 so a mediocre best-of-junk set
 * does not inject its own top hit. */
const PROACTIVE_FRACTION_OF_TOP = 0.4;
/** Default min cosine for proactive dense exemption (see SearchMemoryOptions). */
export const DEFAULT_PROACTIVE_MIN_DENSE_COSINE = 0.38;

/**
 * Relevance floor for the fused hit list. Proactive recall injects the top-k hits
 * into EVERY turn's cache-stable prefix, so a junk match that merely shares one
 * incidental token pollutes the whole session. This drops weak hits so a
 * junk-only result set surfaces NOTHING (empty recall is honest and already
 * handled downstream).
 *
 * Scored from the QUERY, never the fused RRF score. RRF is RANK-based: a lone
 * junk hit gets the same 1/(k+0) as a lone strong hit, so a floor on the fused
 * score can't tell them apart. The real relevance signal lives pre-fusion, in
 * BM25 (relative) and raw query-term overlap (absolute) — so we recompute both
 * here. Applied as a post-fusion FILTER, so the RRF ordering of the survivors is
 * preserved (the normal path is unaffected when every hit is genuinely relevant).
 *
 * Dense (semantic) hits:
 * - **explicit**: exempt from the lexical floor (paraphrase recall).
 * - **proactive**: exempt only when cosine ≥ `minDenseCosine`. A bare top-k
 *   nearest neighbour with score 0.1 is noise, not a paraphrase.
 *
 * Two criteria, both required (for a lexical hit):
 *  - ABSOLUTE overlap: the hit must contain at least `minOverlap` DISTINCT query
 *    terms. Explicit: ≥2 for ≥4-term queries, ≥1 otherwise. Proactive: ≥3 for
 *    ≥4-term queries (so `make`+`website` alone cannot qualify a world-cup
 *    digest), ≥2 for 2–3 term, ≥1 for a single term.
 *  - RELATIVE score: the hit's corpus-relative BM25 across the candidate set must
 *    be at least `FRACTION_OF_TOP` (or the proactive fraction) of the best hit's.
 */
function applyRelevanceFloor(
  query: string,
  hits: MemoryHit[],
  denseCosine: ReadonlyMap<string, number>,
  mode: MemorySearchMode,
  minDenseCosine: number,
): MemoryHit[] {
  if (hits.length === 0) return hits;
  const qterms = queryTerms(query);
  if (!qterms.length) return hits; // no meaningful terms → nothing to floor against
  const minOverlap =
    mode === "proactive"
      ? qterms.length >= 4
        ? 3
        : qterms.length >= 2
          ? 2
          : 1
      : qterms.length >= 4
        ? 2
        : 1;
  const fraction = mode === "proactive" ? PROACTIVE_FRACTION_OF_TOP : FRACTION_OF_TOP;
  // Corpus-relative BM25 across the candidate hits — a real relevance measure,
  // unlike the rank-based RRF score. Zero-overlap hits are absent from `rel`.
  const rel = rankBm25(query, hits.map((h) => h.text), qterms);
  const scoreByIndex = new Map<number, number>();
  for (const h of rel) scoreByIndex.set(h.index, h.score);
  const top = rel[0]?.score ?? 0;
  return hits.filter((h, i) => {
    const cos = denseCosine.get(h.id);
    if (cos !== undefined) {
      // Explicit: any dense-ranked id bypasses the lexical floor (paraphrase
      // recall). Proactive: only a strong cosine does — weak top-k neighbors
      // must still pass the lexical gate (and usually fail it).
      if (mode !== "proactive" || cos >= minDenseCosine) return true;
    }
    const tokens = new Set(tokenize(h.text));
    let overlap = 0;
    for (const t of qterms) if (tokens.has(t)) overlap++;
    if (overlap < minOverlap) return false;
    const score = scoreByIndex.get(i) ?? 0;
    return top === 0 || score >= fraction * top;
  });
}

/**
 * Hybrid memory search: fuses up to three rankings — lexical BM25 over the memory
 * corpus, dense (semantic) nearest-neighbours over the same corpus, and lexical
 * recall over past sessions — with reciprocal-rank fusion. RRF is rank-based, so
 * it combines BM25 and cosine without normalizing their incomparable scales, and
 * a chunk that ranks well in BOTH lexical and dense is boosted (the hybrid win).
 *
 * Degrades cleanly: with no embedder it's lexical memory + sessions; with no
 * memory files it's just session recall — a strict superset of the old behavior.
 */
export async function searchMemory(opts: SearchMemoryOptions): Promise<MemoryHit[]> {
  const {
    cwd,
    query,
    sources,
    semantic,
    limit = 8,
    mode = "explicit",
    minDenseCosine = DEFAULT_PROACTIVE_MIN_DENSE_COSINE,
  } = opts;
  // Proactive injection must not fuse raw past-session transcripts — those are
  // the noisiest source of "make a website" false positives. Explicit `/recall`
  // keeps sessions on by default.
  const includeSessions = opts.includeSessions ?? mode !== "proactive";
  const rankings: string[][] = [];
  const byId = new Map<string, MemoryHit>();
  // Dense ids → cosine score. Used by the relevance floor: explicit exempts any
  // dense-ranked id; proactive requires cosine ≥ minDenseCosine.
  const denseCosine = new Map<string, number>();

  // Chunk the corpus once (shared by the lexical pass and as hit metadata).
  const chunks = sources.flatMap((s) => chunkMarkdown(s.source, s.text));
  for (const c of chunks) {
    byId.set(c.id, { id: c.id, source: c.source, heading: c.heading, text: c.text, kind: "memory", score: 0 });
  }

  // Lexical BM25 over memory chunks.
  if (chunks.length) {
    const lex = rankBm25(query, chunks.map((c) => c.text));
    rankings.push(lex.map((h) => chunks[h.index]!.id));
  }

  // Dense (semantic) over the same corpus. Reconcile-on-read keeps the index in
  // sync (cheap when nothing changed) so dense ids line up with current chunks.
  // Guard an empty/whitespace query: embedding "" yields a real vector and would
  // return cosine-nearest chunks as if relevant (the lexical BM25 pass already
  // returns nothing for empty terms). Still reconcile the index so a later real
  // query is fresh, but don't rank on a meaningless embedding.
  if (semantic && chunks.length && query.trim()) {
    try {
      await semantic.index(sources);
      const dense = await semantic.search(query, limit * 3);
      rankings.push(dense.map((h) => h.id));
      for (const h of dense) {
        denseCosine.set(h.id, h.score);
        if (!byId.has(h.id)) {
          byId.set(h.id, { id: h.id, source: h.source, heading: h.heading, text: h.text, kind: "memory", score: 0 });
        }
      }
    } catch {
      // A transient embed/index failure must not break recall — lexical stands in.
    }
  }

  // Lexical recall over past sessions (a separate corpus, fused by RRF).
  if (includeSessions) {
    const sessionHits = await searchSessions(cwd, query, { limit: limit * 2 });
    const ids: string[] = [];
    sessionHits.forEach((h, i) => {
      const id = `session:${h.sessionId}:${i}`;
      ids.push(id);
      byId.set(id, {
        id,
        source: h.sessionId,
        heading: h.goal ?? "",
        text: h.snippet,
        kind: "session",
        score: 0,
      });
    });
    if (ids.length) rankings.push(ids);
  }

  if (!rankings.length) return [];
  const fused: MemoryHit[] = [];
  for (const { id, score } of reciprocalRankFusion(rankings)) {
    const hit = byId.get(id);
    if (hit) fused.push({ ...hit, score });
  }
  // Apply the relevance floor BEFORE the limit cut: a weak hit near the top must
  // not shadow a stronger one below it, and a junk-only set must return empty
  // rather than a `limit`-length list of noise.
  return applyRelevanceFloor(query, fused, denseCosine, mode, minDenseCosine).slice(0, limit);
}

/** Render hybrid memory hits as a compact block for the model / `/recall`. */
export function formatMemoryHits(query: string, hits: MemoryHit[]): string {
  if (!hits.length) return `No memory matches for "${query}".`;
  const lines = hits.map((h) => {
    const label = h.kind === "session" ? `session ${h.source}` : h.source;
    const head = h.heading ? `${label} · ${h.heading}` : label;
    const snippet = h.text.replace(/\s+/g, " ").trim().slice(0, 280);
    return `  • ${head}\n    ${snippet}`;
  });
  return `Memory — ${hits.length} match(es) for "${query}":\n${lines.join("\n")}`;
}
