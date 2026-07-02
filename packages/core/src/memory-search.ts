import { chunkMarkdown } from "./chunk.ts";
import { rankBm25, reciprocalRankFusion } from "./bm25.ts";
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
  const out: MemoryHit[] = [];
  for (const { id, score } of reciprocalRankFusion(rankings)) {
    const hit = byId.get(id);
    if (hit) out.push({ ...hit, score });
    if (out.length >= limit) break;
  }
  return out;
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
