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
 * The scoring is deliberately simple and deterministic (term-frequency over the
 * message text, with a small recency tie-breaker) so it works offline with no
 * embeddings or vector store. The `recall_memory` tool exposes the same engine
 * to the model.
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
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const limit = opts.limit ?? 8;

  const store = new SessionStore(cwd);
  let metas: SessionMeta[];
  try {
    metas = await store.list();
  } catch {
    return [];
  }

  const hits: RecallHit[] = [];
  // Recency tie-breaker: scale into a tiny [0, 0.5) bonus by list order.
  for (let m = 0; m < metas.length; m++) {
    const meta = metas[m]!;
    if (opts.excludeId && meta.id === opts.excludeId) continue;
    const recencyBonus = (metas.length - m) / (metas.length * 2 + 1); // < 0.5
    const loaded = await store.load(meta.id).catch(() => null);
    if (!loaded) continue;
    for (const msg of loaded.history) {
      const text = messageText(msg.parts);
      if (!text) continue;
      const haystack = text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        let idx = haystack.indexOf(term);
        while (idx !== -1) {
          score += 1;
          idx = haystack.indexOf(term, idx + term.length);
        }
      }
      if (score <= 0) continue;
      hits.push({
        sessionId: meta.id,
        goal: meta.goal,
        when: meta.updatedAt,
        role: msg.role,
        snippet: snippetFor(text, terms),
        score: score + recencyBonus,
      });
    }
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
