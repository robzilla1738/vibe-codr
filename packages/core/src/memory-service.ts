import type { Config } from "@vibe/config";
import type { ProviderRegistry } from "@vibe/providers";
import type { Logger } from "@vibe/shared";
import { resolveEmbedder } from "./embeddings.ts";
import { openSemanticMemory, type SemanticMemory } from "./semantic-memory.ts";
import { searchMemory, type MemoryHit } from "./memory-search.ts";
import { gatherMemoryDocs, appendMemory, type SaveMemoryInput } from "./memory-store.ts";

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
    const sources = await gatherMemoryDocs(this.#cwd);
    return searchMemory({
      cwd: this.#cwd,
      query,
      sources,
      ...(this.#semantic ? { semantic: this.#semantic } : {}),
      limit,
    });
  }

  /** Persist a fact to the saved-memory store; recall picks it up on next search. */
  async save(input: SaveMemoryInput): Promise<string> {
    return appendMemory(this.#cwd, input);
  }

  close(): void {
    this.#semantic?.close();
  }
}
