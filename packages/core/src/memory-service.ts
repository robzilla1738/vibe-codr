import type { Config } from "@vibe/config";
import type { ProviderRegistry } from "@vibe/providers";
import type { Logger } from "@vibe/shared";
import { resolveEmbedder } from "./embeddings.ts";
import { openSemanticMemory, type SemanticMemory, type MemoryDoc } from "./semantic-memory.ts";
import { searchMemory, type MemoryHit, type MemorySearchMode } from "./memory-search.ts";
import {
  gatherMemoryDocs,
  appendMemory,
  type SaveMemoryInput,
  type SaveMemoryResult,
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
      // Preserve vectors for files that failed to read (don't let the index
      // reconciler prune them). Add their source names to the corpus as "keep"
      // markers so pruneSourcesExcept doesn't drop them — their chunks stay
      // indexed and searchable even though their source file is temporarily
      // unreadable. The next successful read will reconcile them normally.
      if (gathered.failedSources.length && this.#semantic) {
        // Mark failed sources as "kept" by adding empty docs — the index reconciler
        // will see them as existing sources and preserve their vectors without
        // re-embedding (no new chunks to add from an empty doc).
        for (const src of gathered.failedSources) {
          sources.push({ source: src, text: "" });
        }
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
    return appendMemory(this.#cwd, input);
  }

  close(): void {
    this.#semantic?.close();
  }
}
