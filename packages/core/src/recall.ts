import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Message, Part } from "@vibe/shared";
import { SessionStore, type SessionMeta } from "./store.ts";

/**
 * Session memory ("recall"): a lexical, dependency-free search across every
 * persisted session under `.vibe/sessions/`. It lets the agent — and the user,
 * via `/recall` — look up what was said or decided in past conversations,
 * turning a pile of session files into searchable long-term memory.
 *
 * Scoring is deterministic Okapi BM25 over word-boundary tokens (not raw
 * substring counts), so "the" no longer matches inside "other", common words are
 * deweighted by IDF, and long messages don't dominate by sheer length. It works
 * fully offline with no embeddings or vector store. Phase 1 fuses a dense
 * (semantic) scorer on top via reciprocal-rank fusion; this is the lexical half.
 * The `recall_memory` tool exposes the same engine to the model.
 */

/** Very common words carry little signal; drop them from the query (IDF already
 * deweights them, but dropping avoids noisy snippet centering). Kept only if a
 * query is ALL stopwords, so a literal phrase still matches something. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "is",
  "are", "was", "were", "be", "been", "with", "that", "this", "it", "as", "at",
  "by", "from", "we", "you", "do", "did", "does", "how", "what", "when",
]);

/** BM25 term-frequency saturation (k1) and length-normalization (b) constants. */
const BM25_K1 = 1.5;
const BM25_B = 0.75;
export interface RecallHit {
  sessionId: string;
  /** Session goal, if one was set — useful context for the snippet. */
  goal: string | null;
  /** Last-updated time of the session (ms epoch). */
  when: number;
  role: Message["role"];
  /** A short excerpt of the matching message, centered on the best term hit. */
  snippet: string;
  score: number;
}

export interface RecallOptions {
  /** Max hits to return (default 8). */
  limit?: number;
  /** Skip this session id (usually the live one) to surface *other* memory. */
  excludeId?: string;
}

/** Split a query/string into lowercased word tokens (length ≥ 2). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2);
}

/** Flatten a message's renderable text (text + reasoning parts). */
function messageText(parts: Part[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (p.type === "text" || p.type === "reasoning") out.push(p.text);
    else if (p.type === "tool-call") out.push(p.toolName);
  }
  return out.join(" ").trim();
}

/** Extract a ~240-char excerpt centered on the first matching query term. */
function snippetFor(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const width = 240;
  if (at === -1 || flat.length <= width) {
    return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
  }
  const start = Math.max(0, at - width / 3);
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * Search every saved session (newest first) for `query`, returning the best
 * matching messages across all of them. Sessions with no `.vibe/sessions` dir
 * or unreadable history are skipped silently.
 */
export async function searchSessions(
  cwd: string,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallHit[]> {
  const allTerms = [...new Set(tokenize(query))];
  if (!allTerms.length) return [];
  // Drop stopwords unless that empties the query (so a literal phrase still matches).
  const meaningful = allTerms.filter((t) => !STOPWORDS.has(t));
  const terms = meaningful.length ? meaningful : allTerms;
  const limit = opts.limit ?? 8;

  const store = new SessionStore(cwd);
  let metas: SessionMeta[];
  try {
    metas = await store.list();
  } catch {
    return [];
  }

  // First pass: every message becomes a BM25 "document". We load only the UI
  // history (not the much larger model transcript) since that's all recall reads.
  interface Doc {
    sessionId: string;
    goal: string | null;
    when: number;
    role: Message["role"];
    text: string;
    length: number;
    tf: Map<string, number>;
    recencyBonus: number;
  }
  const docs: Doc[] = [];
  for (let m = 0; m < metas.length; m++) {
    const meta = metas[m]!;
    if (opts.excludeId && meta.id === opts.excludeId) continue;
    const recencyBonus = (metas.length - m) / (metas.length * 2 + 1); // < 0.5
    const history = await store.loadHistory(meta.id).catch(() => [] as Message[]);
    for (const msg of history) {
      const text = messageText(msg.parts);
      if (!text) continue;
      const tokens = tokenize(text);
      if (!tokens.length) continue;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      docs.push({
        sessionId: meta.id,
        goal: meta.goal,
        when: meta.updatedAt,
        role: msg.role,
        text,
        length: tokens.length,
        tf,
        recencyBonus,
      });
    }
  }
  if (!docs.length) return [];

  // Corpus statistics for BM25: N, average doc length, and per-term document
  // frequency (exact token matches, so "the" can't match inside "other").
  const N = docs.length;
  const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const t of terms) {
    let n = 0;
    for (const d of docs) if (d.tf.has(t)) n++;
    df.set(t, n);
  }
  const idf = (t: string): number => {
    const n = df.get(t) ?? 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  const hits: RecallHit[] = [];
  for (const d of docs) {
    let score = 0;
    for (const t of terms) {
      const f = d.tf.get(t) ?? 0;
      if (!f) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (d.length / avgdl));
      score += idf(t) * ((f * (BM25_K1 + 1)) / denom);
    }
    if (score <= 0) continue;
    hits.push({
      sessionId: d.sessionId,
      goal: d.goal,
      when: d.when,
      role: d.role,
      snippet: snippetFor(d.text, terms),
      // Recency only breaks ties between equal-relevance hits, so scale it well
      // below a single term's BM25 contribution.
      score: score + d.recencyBonus * 0.01,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** Render recall hits as a compact, readable block for `/recall` output. */
export function formatRecall(query: string, hits: RecallHit[]): string {
  if (!hits.length) {
    return `No matches for "${query}" in saved sessions.`;
  }
  const lines = hits.map((h) => {
    const when = new Date(h.when).toISOString().replace("T", " ").slice(0, 16);
    const head = `${h.sessionId} · ${when} · ${h.role}${h.goal ? ` · ★ ${h.goal}` : ""}`;
    return `  ${head}\n    ${h.snippet}`;
  });
  return `Recall — ${hits.length} match(es) for "${query}":\n${lines.join("\n")}`;
}

/** Used by the directory listing; mirrors SessionStore's base path. */
export async function hasSavedSessions(cwd: string): Promise<boolean> {
  try {
    const entries = await readdir(join(cwd, ".vibe", "sessions"));
    return entries.length > 0;
  } catch {
    return false;
  }
}
