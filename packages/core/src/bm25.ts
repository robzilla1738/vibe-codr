/**
 * Dependency-free Okapi BM25 ranking over word-boundary tokens, shared by
 * session recall and memory search. Word-boundary tokenization means "the"
 * never matches inside "other"; IDF deweights ubiquitous terms; length
 * normalization stops long documents winning by sheer size.
 */

/** Very common words carry little signal; dropped from the query (IDF already
 * deweights them, but dropping avoids noisy snippet centering). Kept only when a
 * query is ALL stopwords, so a literal phrase still matches something. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "with",
  "that",
  "this",
  "it",
  "as",
  "at",
  "by",
  "from",
  "we",
  "you",
  "do",
  "did",
  "does",
  "how",
  "what",
  "when",
]);

/** BM25 term-frequency saturation (k1) and length-normalization (b). */
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** Lowercase word tokens of length ≥ 2 (drops punctuation and 1-char noise). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2);
}

/** Unique query terms with stopwords dropped (unless that empties the query). */
export function queryTerms(query: string): string[] {
  const all = [...new Set(tokenize(query))];
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  return meaningful.length ? meaningful : all;
}

/** One scored document: its index in the input array and BM25 score (> 0). */
export interface Bm25Hit {
  index: number;
  score: number;
}

/**
 * Rank `texts` against `query` with BM25, returning only positive-scoring docs
 * sorted by score descending. Pre-tokenized `terms` may be passed to score many
 * corpora against one query without re-parsing it.
 */
export function rankBm25(
  query: string,
  texts: string[],
  terms: string[] = queryTerms(query),
): Bm25Hit[] {
  if (!terms.length || !texts.length) return [];

  const tfs: Map<string, number>[] = [];
  const lengths: number[] = [];
  let totalLen = 0;
  for (const text of texts) {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    tfs.push(tf);
    lengths.push(tokens.length);
    totalLen += tokens.length;
  }
  const N = texts.length;
  const avgdl = totalLen / N || 1;

  const df = new Map<string, number>();
  for (const t of terms) {
    let n = 0;
    for (const tf of tfs) if (tf.has(t)) n++;
    df.set(t, n);
  }
  const idf = (t: string): number => {
    const n = df.get(t) ?? 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  const hits: Bm25Hit[] = [];
  for (let i = 0; i < N; i++) {
    const tf = tfs[i]!;
    const len = lengths[i]!;
    let score = 0;
    for (const t of terms) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (len / avgdl));
      score += idf(t) * ((f * (BM25_K1 + 1)) / denom);
    }
    if (score > 0) hits.push({ index: i, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * Reciprocal-rank fusion of several ranked id-lists into one consensus order.
 * Each list contributes 1/(k + rank) per id (rank is 0-based); a higher `k`
 * flattens the weight of top ranks. Returns ids sorted by fused score desc.
 * RRF is rank-based, so it fuses scorers on incomparable scales (BM25 vs cosine)
 * without normalization.
 */
export function reciprocalRankFusion(
  rankings: string[][],
  k = 60,
): { id: string; score: number }[] {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank++) {
      const id = ranking[rank]!;
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank));
    }
  }
  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
