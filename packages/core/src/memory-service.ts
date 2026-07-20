import type { Config } from "@vibe/config";
import type { ProviderRegistry } from "@vibe/providers";
import type { Logger } from "@vibe/shared";
import { resolveEmbedder } from "./embeddings.ts";
import { openSemanticMemory, type SemanticMemory, type MemoryDoc } from "./semantic-memory.ts";
import { searchMemory, type MemoryHit, type MemorySearchMode } from "./memory-search.ts";
import {
  gatherMemoryDocs,
  appendMemory,
  forgetMemoryEntry,
  listMemoryEntries,
  selectMemoryEntry,
  setMemoryPinned,
  type SaveMemoryInput,
  type SaveMemoryResult,
  type StoredMemoryEntry,
} from "./memory-store.ts";

/** Options for {@link MemoryService.search}. */
export interface MemorySearchServiceOptions {
  /** Default `explicit` (`/recall` / tool). Use `proactive` for session-start injection. */
  mode?: MemorySearchMode;
  /** Min cosine for dense exemption under proactive mode. */
  minDenseCosine?: number;
  /** Override session-transcript fusion (proactive defaults this off). */
  includeSessions?: boolean;
}

export interface MergeMemoryResult {
  replacement: StoredMemoryEntry;
  removed: StoredMemoryEntry[];
}

/**
 * The long-term memory façade the engine owns and shares with the session tree.
 * It ties together the (optional) semantic index, the saved-memory store, and
 * past-session recall behind two operations — search (hybrid) and save. It works
 * with or without an embedder: no embedder → lexical BM25 over memory + sessions.
 */
export class MemoryService {
  #cwd: string;
  #semantic: SemanticMemory | undefined;

  private constructor(cwd: string, semantic: SemanticMemory | undefined) {
    this.#cwd = cwd;
    this.#semantic = semantic;
  }

  /** Build the service, resolving the configured embedder (gracefully none). */
  static async create(
    cwd: string,
    config: Config,
    registry: ProviderRegistry,
    logger?: Logger,
  ): Promise<MemoryService> {
    const embedder = await resolveEmbedder(config, registry, logger);
    const semantic = embedder ? openSemanticMemory(cwd, embedder) : undefined;
    return new MemoryService(cwd, semantic);
  }

  /** Whether a dense (semantic) layer is active (vs lexical-only). */
  get semanticEnabled(): boolean {
    return this.#semantic !== undefined;
  }

  /** Rebuildable shadow reconciliation. A transient read failure skips the
   * entire semantic update rather than presenting a partial corpus as truth and
   * pruning vectors for the unreadable source. */
  async reconcile(): Promise<void> {
    if (!this.#semantic) return;
    try {
      const gathered = await gatherMemoryDocs(this.#cwd);
      if (gathered.failedSources.length) return;
      // Empty is meaningful: the final memory was deleted, so prune the shadow.
      await this.#semantic.index(gathered.docs);
    } catch {
      // The index is a rebuildable enhancement; a memory write remains durable
      // and the next healthy search/save retries reconciliation.
    }
  }

  /** Hybrid recall over saved memory + past sessions. Reconciles the index on
   * read (cheap when unchanged), so a just-saved fact is searchable immediately. */
  async search(
    query: string,
    limit = 8,
    opts: MemorySearchServiceOptions = {},
  ): Promise<MemoryHit[]> {
    // A transient corpus-read failure must NOT reach the semantic layer: indexing
    // a partial/empty corpus would prune every vector for the scope (reconcile-on-
    // read treats "not in this corpus" as "deleted"). On such a failure, degrade to
    // session-only recall WITHOUT touching the index, so a momentary FS hiccup can't
    // wipe and force a full re-embed.
    let sources: MemoryDoc[];
    try {
      const gathered = await gatherMemoryDocs(this.#cwd);
      sources = gathered.docs;
      // A partial corpus must not reach reconcile-on-read: an empty keep marker
      // would be interpreted as deletion by SemanticMemory.index. Lexical recall
      // over healthy files still works; dense recall returns next healthy read.
      if (gathered.failedSources.length) {
        return searchMemory({
          cwd: this.#cwd,
          query,
          sources,
          limit,
          ...(opts.mode ? { mode: opts.mode } : {}),
          ...(opts.minDenseCosine !== undefined ? { minDenseCosine: opts.minDenseCosine } : {}),
          ...(opts.includeSessions !== undefined ? { includeSessions: opts.includeSessions } : {}),
        });
      }
    } catch {
      return searchMemory({
        cwd: this.#cwd,
        query,
        sources: [],
        limit,
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.minDenseCosine !== undefined ? { minDenseCosine: opts.minDenseCosine } : {}),
        ...(opts.includeSessions !== undefined ? { includeSessions: opts.includeSessions } : {}),
      });
    }
    return searchMemory({
      cwd: this.#cwd,
      query,
      sources,
      ...(this.#semantic ? { semantic: this.#semantic } : {}),
      limit,
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.minDenseCosine !== undefined ? { minDenseCosine: opts.minDenseCosine } : {}),
      ...(opts.includeSessions !== undefined ? { includeSessions: opts.includeSessions } : {}),
    });
  }

  /** Persist a fact to the saved-memory store; recall picks it up on next search
   * (scope "user" lands in the always-injected USER.md instead). An equivalent
   * already-stored fact is skipped and reported via `deduped`. */
  async save(input: SaveMemoryInput): Promise<SaveMemoryResult> {
    // The summarizer is instructed to stay within 80 words, but provider output
    // is not a contract. Enforce the compact-index boundary before persistence.
    const bounded = input.tags?.includes("session-digest")
      ? { ...input, fact: input.fact.trim().split(/\s+/).slice(0, 80).join(" ") }
      : input;
    const saved = await appendMemory(this.#cwd, bounded);
    // Finalize awaits save(), so a compact session digest is embedded before
    // the engine closes the semantic store. The raw transcript is never an
    // input here: gatherMemoryDocs reads only curated/saved markdown.
    await this.reconcile();
    return saved;
  }

  async listEntries(): Promise<StoredMemoryEntry[]> {
    return listMemoryEntries(this.#cwd);
  }

  async setPinned(prefix: string, pinned: boolean): Promise<StoredMemoryEntry> {
    const updated = await setMemoryPinned(this.#cwd, prefix, pinned);
    await this.reconcile();
    return updated;
  }

  async forget(prefix: string): Promise<StoredMemoryEntry> {
    const removed = await forgetMemoryEntry(this.#cwd, prefix);
    await this.reconcile();
    return removed;
  }

  /** Loss-averse merge: resolve every source first, write + index the replacement,
   * then remove originals. Any later failure can leave duplicates, never erase
   * both the old knowledge and its replacement. */
  async merge(prefixes: string[], fact: string): Promise<MergeMemoryResult> {
    const cleanFact = fact.replace(/\s+/g, " ").trim();
    if (!cleanFact) throw new Error("merged memory fact cannot be empty");
    const entries = await listMemoryEntries(this.#cwd);
    const selected = prefixes.map((prefix) => selectMemoryEntry(entries, prefix));
    const unique = [...new Map(selected.map((entry) => [entry.id, entry])).values()];
    if (unique.length < 2) throw new Error("merge requires at least two distinct memory ids");
    const scopes = new Set(unique.map((entry) => entry.scope));
    if (scopes.size !== 1) throw new Error("merge requires memories from the same scope");
    const scope = unique[0]!.scope;
    const saved = await this.save({
      fact: cleanFact,
      scope,
      tags: unique.some((entry) => entry.pinned) ? ["pinned", "merged"] : ["merged"],
    });
    if (saved.deduped) {
      throw new Error("merged replacement already exists; originals were preserved");
    }
    const withReplacement = await listMemoryEntries(this.#cwd);
    const replacement = withReplacement.find(
      (entry) => entry.scope === scope && entry.fact.replace(/\s+/g, " ").trim() === cleanFact,
    );
    if (!replacement)
      throw new Error("merged replacement could not be verified; originals were preserved");

    const removed: StoredMemoryEntry[] = [];
    try {
      for (const entry of unique) removed.push(await forgetMemoryEntry(this.#cwd, entry.id));
    } finally {
      // Also runs after a partial removal failure, keeping the live shadow exact.
      await this.reconcile();
    }
    return { replacement, removed };
  }

  close(): void {
    this.#semantic?.close();
  }
}
