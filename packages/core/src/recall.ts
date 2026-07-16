import { readdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { Message, Part } from "@vibe/shared";
import { SessionStore, type SessionMeta } from "./store.ts";
import { globalStateDir } from "./state-dir.ts";
import { queryTerms, rankBm25 } from "./bm25.ts";

/**
 * Module-level scan cache: `recall` used to re-list AND re-read every session's
 * `history.jsonl` on every query, which is O(all sessions) disk work per search.
 * We cache each session's parsed history keyed by the absolute history-file path,
 * validated by its on-disk `mtimeMs`: an unchanged file is served from memory,
 * and only a file whose mtime moved is re-read + re-parsed. Results stay
 * byte-identical to a cold read (same parsed messages → same BM25 ranking).
 */
interface CachedHistory {
  mtimeMs: number;
  messages: Message[];
}
const scanCache = new Map<string, CachedHistory>();

/** Test hook: wipe the scan cache so tests don't leak state across cases. */
export function _resetRecallCache(): void {
  scanCache.clear();
}

/**
 * Load a session's UI history, serving from the mtime-keyed cache when the file
 * hasn't changed. A missing/unreadable history file yields `[]` (uncached, since
 * there's no mtime to key on) — mirroring `SessionStore.loadHistory`.
 */
async function loadHistoryCached(cwd: string, store: SessionStore, id: string): Promise<Message[]> {
  // Sessions live in the project's global state dir; older ones may still sit
  // in the legacy in-project location — stat whichever exists for the mtime key.
  let path = join(globalStateDir(cwd), "sessions", id, "history.jsonl");
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    path = join(cwd, ".vibe", "sessions", id, "history.jsonl");
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return [];
    }
  }
  const cached = scanCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.messages;
  const messages = await store.loadHistory(id).catch(() => [] as Message[]);
  scanCache.set(path, { mtimeMs, messages });
  return messages;
}

/**
 * Session memory ("recall"): a lexical, dependency-free search across every
 * persisted session (under the project's global state dir, legacy in-project
 * `.vibe/sessions/` still read). It lets the agent — and the user,
 * via `/recall` — look up what was said or decided in past conversations,
 * turning a pile of session files into searchable long-term memory.
 *
 * Scoring is the shared deterministic Okapi BM25 ranker (`./bm25.ts`) over
 * word-boundary tokens, so "the" no longer matches inside "other", common words
 * are deweighted by IDF, and long messages don't dominate by length. It works
 * fully offline with no embeddings. The memory subsystem fuses a dense (semantic)
 * scorer on top of this lexical half via reciprocal-rank fusion (`./memory-search.ts`).
 * The `recall_memory` tool exposes the same engine to the model.
 */

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
 * matching messages across all of them. Sessions with no persisted-sessions dir
 * or unreadable history are skipped silently.
 */
export async function searchSessions(
  cwd: string,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallHit[]> {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const limit = opts.limit ?? 8;

  const store = new SessionStore(cwd);
  let metas: SessionMeta[];
  try {
    metas = await store.list();
  } catch {
    return [];
  }

  // Every message becomes a BM25 "document". We load only the UI history (not the
  // much larger model transcript) since that's all recall reads. Recency is a
  // per-doc tie-breaker applied after scoring.
  interface Doc {
    sessionId: string;
    goal: string | null;
    when: number;
    role: Message["role"];
    text: string;
    recencyBonus: number;
  }
  const docs: Doc[] = [];
  for (let m = 0; m < metas.length; m++) {
    const meta = metas[m]!;
    if (opts.excludeId && meta.id === opts.excludeId) continue;
    const recencyBonus = (metas.length - m) / (metas.length * 2 + 1); // < 0.5
    const history = await loadHistoryCached(cwd, store, meta.id);
    for (const msg of history) {
      const text = messageText(msg.parts);
      if (!text) continue;
      docs.push({
        sessionId: meta.id,
        goal: meta.goal,
        when: meta.updatedAt,
        role: msg.role,
        text,
        recencyBonus,
      });
    }
  }
  if (!docs.length) return [];

  const ranked = rankBm25(
    query,
    docs.map((d) => d.text),
    terms,
  );
  const hits: RecallHit[] = ranked.map(({ index, score }) => {
    const d = docs[index]!;
    return {
      sessionId: d.sessionId,
      goal: d.goal,
      when: d.when,
      role: d.role,
      snippet: snippetFor(d.text, terms),
      // Recency only breaks ties between equal-relevance hits, so scale it well
      // below a single term's BM25 contribution.
      score: score + d.recencyBonus * 0.01,
    };
  });

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

/** Used by the directory listing; mirrors SessionStore's base paths (global
 * state dir first, legacy in-project fallback). */
export async function hasSavedSessions(cwd: string): Promise<boolean> {
  for (const base of [join(globalStateDir(cwd), "sessions"), join(cwd, ".vibe", "sessions")]) {
    try {
      if ((await readdir(base)).length > 0) return true;
    } catch {
      /* try the next location */
    }
  }
  return false;
}
