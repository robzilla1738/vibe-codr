import { join } from "node:path";
import type { Embedder } from "./embeddings.ts";
import { chunkMarkdown } from "./chunk.ts";
import { globalStateDir } from "./state-dir.ts";
import { VectorStore, type VectorHit, type VectorRecord } from "./vector-store.ts";

/** A source document to index: a logical id/path plus its current markdown. */
export interface MemoryDoc {
  source: string;
  text: string;
}

/**
 * Semantic memory: keeps a vector index in sync with a corpus of markdown
 * memory files and answers nearest-neighbour queries. Indexing is idempotent and
 * incremental — only new/changed chunks are embedded (content-addressed ids),
 * removed chunks and removed sources are pruned — so reconciling on every read is
 * cheap when nothing changed. Markdown stays the source of truth; the index is a
 * rebuildable shadow.
 */
export class SemanticMemory {
  #embedder: Embedder;
  #store: VectorStore;

  constructor(embedder: Embedder, store: VectorStore) {
    this.#embedder = embedder;
    this.#store = store;
  }

  /**
   * Reconcile the index against the FULL current corpus: embed only chunks not
   * already stored, delete chunks that disappeared, and prune sources no longer
   * present. Callers must pass the complete corpus (a partial list would prune
   * the rest). Returns how many chunks were added/removed.
   */
  async index(sources: MemoryDoc[]): Promise<{ added: number; removed: number }> {
    let added = 0;
    let removed = 0;
    const keep = new Set<string>();
    for (const src of sources) {
      keep.add(src.source);
      const chunks = chunkMarkdown(src.source, src.text);
      const existing = this.#store.idsForSource(src.source);
      const current = new Set(chunks.map((c) => c.id));
      const toAdd = chunks.filter((c) => !existing.has(c.id));
      const toDelete = [...existing].filter((id) => !current.has(id));
      if (toAdd.length) {
        const vectors = await this.#embedder.embed(toAdd.map((c) => c.text));
        const records: VectorRecord[] = toAdd.map((c, i) => ({ ...c, vector: vectors[i]! }));
        this.#store.upsert(records);
        added += toAdd.length;
      }
      if (toDelete.length) {
        this.#store.deleteIds(toDelete);
        removed += toDelete.length;
      }
    }
    this.#store.pruneSourcesExcept(keep);
    return { added, removed };
  }

  /** Nearest-neighbour search: embed the query and return the top-`k` chunks. */
  async search(query: string, k = 8): Promise<VectorHit[]> {
    const [vec] = await this.#embedder.embed([query]);
    if (!vec?.length) return [];
    return this.#store.search(vec, k);
  }

  /** Number of indexed chunks. */
  count(): number {
    return this.#store.count();
  }

  close(): void {
    this.#store.close();
  }
}

/** Path to a project's semantic index (machine-local, rebuildable shadow). */
export function semanticIndexPath(cwd: string): string {
  return join(globalStateDir(cwd), "memory", "index.sqlite");
}

/**
 * Open semantic memory for a project, backed by a SQLite vector index namespaced
 * to the embedder. `dbPath` defaults to the project shadow path; pass ":memory:"
 * for an ephemeral index. The caller owns `close()`.
 */
export function openSemanticMemory(
  cwd: string,
  embedder: Embedder,
  dbPath: string = semanticIndexPath(cwd),
): SemanticMemory {
  const store = new VectorStore(dbPath, embedder.id, embedder.dimensions);
  return new SemanticMemory(embedder, store);
}
