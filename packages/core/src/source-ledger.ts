/**
 * A per-session ledger of web sources the agent pulled (via `web_search`,
 * `webfetch`, `crawl_docs`). It dedupes by canonical URL, assigns each source a
 * stable `[n]` index in first-seen order, and renders a bounded numbered list —
 * injected into the system prompt so the model can cite `[n]` consistently
 * across turns, and shown by `/sources`.
 *
 * Pure and self-contained: it holds no session state beyond its own entries and
 * is never inherited by forks (each session tracks the sources it read itself).
 */

import { canonicalizeUrl } from "@vibe/tools";

/** The research tools whose results are harvested into the ledger. */
export const RESEARCH_TOOL_NAMES = new Set(["web_search", "webfetch", "crawl_docs"]);

/**
 * Extract up to `max` distinct http(s) URLs from free text (a tool's rendered
 * result), stripping trailing punctuation that abuts a URL in prose (a sentence
 * period, a closing quote, an unbalanced `)`). Pure — no dedup by canonical form
 * (the ledger does that); it only drops exact repeats to stay tight.
 */
export function harvestUrls(text: string, max = 20): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let url = m[0];
    // Peel trailing punctuation: sentence marks, quotes, and an UNBALANCED
    // closing bracket (a wrapping `(url)` in prose), while keeping brackets the
    // URL itself balances — Wikipedia's `.../Foo_(disambiguation)` survives.
    const unbalanced = (s: string, open: string, close: string) =>
      s.split(close).length > s.split(open).length;
    for (;;) {
      const last = url[url.length - 1]!;
      if (".,;:!?\"'”’»".includes(last)) {
        url = url.slice(0, -1);
        continue;
      }
      if (last === ")" && unbalanced(url, "(", ")")) {
        url = url.slice(0, -1);
        continue;
      }
      if (last === "]" && unbalanced(url, "[", "]")) {
        url = url.slice(0, -1);
        continue;
      }
      break;
    }
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

export interface SourceRecord {
  url: string;
  title?: string;
  /** Which tool surfaced this source (e.g. `web_search`). */
  via: string;
}

export interface SourceEntry {
  /** Stable 1-based citation index, assigned in first-seen order. */
  index: number;
  /** Canonical URL (the dedup key and the display form). */
  url: string;
  title?: string;
  via: string;
}

/** Hard cap on retained entries; beyond it the oldest are dropped (with a note). */
const DEFAULT_MAX_ENTRIES = 200;
/** Default char budget for the prompt-facing `format()` render. */
const DEFAULT_FORMAT_CHARS = 2_000;

/** Per-session, ordered, deduped ledger of gathered web sources. */
export class SourceLedger {
  #byCanon = new Map<string, SourceEntry>();
  /** Entries in first-seen order (ascending index). */
  #order: SourceEntry[] = [];
  #next = 1;
  /** Count of entries dropped to stay under the cap (surfaced in `format`). */
  #dropped = 0;

  constructor(private readonly max: number = DEFAULT_MAX_ENTRIES) {}

  /**
   * Record a source. Deduped by canonical URL: a repeat returns the existing
   * entry (back-filling a title it was missing) without minting a new index.
   * Returns the entry (existing or new), or undefined for an unusable URL.
   */
  record(rec: SourceRecord): SourceEntry | undefined {
    const raw = rec.url?.trim();
    if (!raw) return undefined;
    const canon = canonicalizeUrl(raw);
    const existing = this.#byCanon.get(canon);
    if (existing) {
      if (!existing.title && rec.title?.trim()) existing.title = rec.title.trim();
      return existing;
    }
    const entry: SourceEntry = {
      index: this.#next++,
      url: canon,
      via: rec.via,
      ...(rec.title?.trim() ? { title: rec.title.trim() } : {}),
    };
    this.#byCanon.set(canon, entry);
    this.#order.push(entry);
    // Bounded: drop the oldest beyond the cap (its index is retired with it, so
    // surviving indices stay stable). Track the count for the truncation note.
    while (this.#order.length > this.max) {
      const removed = this.#order.shift()!;
      this.#byCanon.delete(removed.url);
      this.#dropped++;
    }
    return entry;
  }

  /** Live entries in first-seen order (treat as read-only). */
  list(): readonly SourceEntry[] {
    return this.#order;
  }

  /** True when `url` (any equivalent spelling) was actually gathered this
   * session — the plan gate uses this to refuse fabricated citations. */
  has(url: string): boolean {
    return this.#byCanon.has(canonicalizeUrl(url));
  }

  /**
   * Restore a persisted ledger (on `--resume`) so the `[n]` citations already in
   * the resumed transcript still resolve, and new sources continue the numbering
   * instead of colliding. Preserves each entry's original index; `#next` advances
   * past the highest seen. Clears any current state first (called once at seed).
   */
  hydrate(entries: readonly SourceEntry[]): void {
    this.#byCanon.clear();
    this.#order = [];
    this.#next = 1;
    this.#dropped = 0;
    for (const e of entries) {
      const canon = canonicalizeUrl(e.url);
      if (this.#byCanon.has(canon)) continue;
      const entry: SourceEntry = {
        index: e.index,
        url: canon,
        via: e.via,
        ...(e.title ? { title: e.title } : {}),
      };
      this.#byCanon.set(canon, entry);
      this.#order.push(entry);
      this.#next = Math.max(this.#next, e.index + 1);
    }
    // Keep the cap invariant if a persisted ledger somehow exceeded it.
    while (this.#order.length > this.max) {
      const removed = this.#order.shift()!;
      this.#byCanon.delete(removed.url);
      this.#dropped++;
    }
  }

  /** Number of retained entries. */
  get size(): number {
    return this.#order.length;
  }

  /**
   * Render the ledger as a numbered `[n] url — title` list. When the full list
   * would exceed `maxChars`, keep the most-recent entries that fit (they're the
   * most relevant to the current turn's citations), show them in ascending index
   * order, and prepend an explicit truncation marker. If the cap has dropped
   * older entries, a note is appended. Empty ledger → "" (or just the drop note).
   */
  format(maxChars: number = DEFAULT_FORMAT_CHARS): string {
    const dropNote = this.#dropped
      ? `…(${this.#dropped} older source${this.#dropped === 1 ? "" : "s"} dropped — ledger caps at ${this.max})`
      : "";
    if (!this.#order.length) return dropNote;
    const budget = Math.max(0, maxChars - (dropNote ? dropNote.length + 1 : 0));
    const render = (e: SourceEntry) => `[${e.index}] ${e.url}${e.title ? ` — ${e.title}` : ""}`;
    const marker = (n: number) =>
      `…(${n} earlier source${n === 1 ? "" : "s"} omitted — /sources for the full list)`;
    const full = this.#order.map(render).join("\n");
    let body: string;
    if (full.length <= budget) {
      body = full;
    } else {
      // Over budget: fill from the newest backward, reserving room for the marker.
      const kept: SourceEntry[] = [];
      let used = marker(this.#order.length).length + 1;
      for (let i = this.#order.length - 1; i >= 0; i--) {
        const cost = render(this.#order[i]!).length + 1;
        if (kept.length && used + cost > budget) break;
        kept.push(this.#order[i]!);
        used += cost;
      }
      kept.reverse();
      const omitted = this.#order.length - kept.length;
      body = `${marker(omitted)}\n${kept.map(render).join("\n")}`;
    }
    return dropNote ? `${body}\n${dropNote}` : body;
  }
}
