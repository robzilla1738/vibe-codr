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

export interface SearchMemoryOptions {
  cwd: string;
  query: string;
  /** The memory-markdown corpus (curated + saved facts), gathered by the caller. */
  sources: MemoryDoc[];
  /** Dense (semantic) layer; omitted when no embedder is available → lexical only. */
  semantic?: SemanticMemory;
  /** Also fuse lexical recall over past sessions (default true). */
  includeSessions?: boolean;
  limit?: number;
}

/** Keep a hit only if its per-hit relevance is at least this fraction of the top
 * hit's — drops stragglers far weaker than a genuinely strong match. Low on
 * purpose: the overlap floor below does the junk-rejection; this only trims the
 * long tail. */
const FRACTION_OF_TOP = 0.25;

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
 * The floor governs LEXICAL hits only. A dense (semantic) hit — one the embedding
 * branch surfaced — is exempt: semantic search exists to match paraphrases that
 * share ZERO surface terms with the query, so a lexical-overlap gate would drop
 * exactly the recall it provides. `denseIds` carries the ids the dense branch
 * ranked (the RRF fusion already knows them); anything else is judged lexically.
 *
 * Two criteria, both required (for a lexical hit):
 *  - ABSOLUTE overlap: the hit must contain at least `minOverlap` DISTINCT query
 *    terms. This is what rejects an ALL-junk set even when its own best hit
 *    defines the top (a relative-only floor can't). `minOverlap` scales with
 *    query specificity: a query with ≥ 4 meaningful terms (proactive seeds —
 *    goal + first prompt — are always this long) demands ≥ 2 overlaps, so a
 *    single shared token can't qualify; a short 1–3 term query stays at ≥ 1 so a
 *    legitimately terse explicit `/recall` isn't over-filtered.
 *  - RELATIVE score: the hit's corpus-relative BM25 across the candidate set must
 *    be at least `FRACTION_OF_TOP` of the best hit's.
 */
function applyRelevanceFloor(
  query: string,
  hits: MemoryHit[],
  denseIds: ReadonlySet<string>,
): MemoryHit[] {
  if (hits.length === 0) return hits;
  const qterms = queryTerms(query);
  if (!qterms.length) return hits; // no meaningful terms → nothing to floor against
  const minOverlap = qterms.length >= 4 ? 2 : 1;
  // Corpus-relative BM25 across the candidate hits — a real relevance measure,
  // unlike the rank-based RRF score. Zero-overlap hits are absent from `rel`.
  const rel = rankBm25(query, hits.map((h) => h.text), qterms);
  const scoreByIndex = new Map<number, number>();
  for (const h of rel) scoreByIndex.set(h.index, h.score);
  const top = rel[0]?.score ?? 0;
  return hits.filter((h, i) => {
    // A dense (semantic) hit bypasses the lexical floor entirely: a paraphrase
    // match legitimately shares no surface terms, so both the overlap gate and
    // the (necessarily zero) BM25 fraction would wrongly drop it.
    if (denseIds.has(h.id)) return true;
    const tokens = new Set(tokenize(h.text));
    let overlap = 0;
    for (const t of qterms) if (tokens.has(t)) overlap++;
    if (overlap < minOverlap) return false;
    const score = scoreByIndex.get(i) ?? 0;
    return top === 0 || score >= FRACTION_OF_TOP * top;
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
  const { cwd, query, sources, semantic, limit = 8, includeSessions = true } = opts;
  const rankings: string[][] = [];
  const byId = new Map<string, MemoryHit>();
  // Ids the dense branch ranked — exempt from the lexical relevance floor so a
  // zero-surface-overlap paraphrase match survives (semantic recall's whole point).
  const denseIds = new Set<string>();

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
        denseIds.add(h.id);
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
  return applyRelevanceFloor(query, fused, denseIds).slice(0, limit);
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
