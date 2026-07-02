import type { Config } from "@vibe/config";
import type { ProviderRegistry } from "@vibe/providers";
import type { Logger } from "@vibe/shared";
import { resolveEmbedder } from "./embeddings.ts";
import { openSemanticMemory, type SemanticMemory, type MemoryDoc } from "./semantic-memory.ts";
import { searchMemory, type MemoryHit } from "./memory-search.ts";
import {
  gatherMemoryDocs,
  appendMemory,
  type SaveMemoryInput,
  type SaveMemoryResult,
} from "./memory-store.ts";

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
  async search(query: string, limit = 8): Promise<MemoryHit[]> {
    // A transient corpus-read failure must NOT reach the semantic layer: indexing
    // a partial/empty corpus would prune every vector for the scope (reconcile-on-
    // read treats "not in this corpus" as "deleted"). On such a failure, degrade to
    // session-only recall WITHOUT touching the index, so a momentary FS hiccup can't
    // wipe and force a full re-embed.
    let sources: MemoryDoc[];
    try {
      sources = await gatherMemoryDocs(this.#cwd);
    } catch {
      return searchMemory({ cwd: this.#cwd, query, sources: [], limit });
    }
    return searchMemory({
      cwd: this.#cwd,
      query,
      sources,
      ...(this.#semantic ? { semantic: this.#semantic } : {}),
      limit,
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
