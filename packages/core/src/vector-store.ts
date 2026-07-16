import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { cosineSimilarity } from "./embeddings.ts";

/** A chunk plus its embedding, ready to persist. */
export interface VectorRecord {
  id: string;
  source: string;
  hash: string;
  heading?: string;
  text: string;
  vector: number[];
}

/** A ranked search result. */
export interface VectorHit {
  id: string;
  source: string;
  heading: string;
  text: string;
  /** Cosine similarity in [-1, 1] (higher = more relevant). */
  score: number;
}

/**
 * A small local vector store over Bun's built-in SQLite — no native deps, no
 * daemon. The DB under the project global state dir is a rebuildable SHADOW of
 * the markdown memory files (markdown stays the source of truth).
 *
 * Search is exact brute-force cosine: for a per-project memory corpus (hundreds
 * to a few thousand chunks) this is sub-millisecond and avoids the complexity and
 * native-extension risk of an ANN index, while the SQLite layer gives durable,
 * incremental, content-addressed storage. The index is namespaced by embedder id
 * + dimensionality; switching embedding models transparently rebuilds it (mixed
 * vector spaces are never compared).
 */
export class VectorStore {
  #db: Database;

  constructor(path: string, model: string, dimensions: number) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    // BUG-063: multi-process writers wait instead of SQLITE_BUSY failure.
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.#db.run(
      `CREATE TABLE IF NOT EXISTS chunks (
         id TEXT PRIMARY KEY,
         source TEXT NOT NULL,
         hash TEXT NOT NULL,
         heading TEXT NOT NULL DEFAULT '',
         text TEXT NOT NULL,
         vector BLOB NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
    this.#db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source)`);
    this.#ensureModel(model, dimensions);
  }

  /** Drop everything if the embedder (model or dim) changed — a stored vector
   * from a different model is not comparable to a new query vector. */
  #ensureModel(model: string, dimensions: number): void {
    const want = `${model}@${dimensions}`;
    const row = this.#db
      .query<{ value: string }, []>(`SELECT value FROM meta WHERE key = 'embedder'`)
      .get();
    if (row?.value === want) return;
    if (row) this.#db.run(`DELETE FROM chunks`);
    this.#db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('embedder', ?)`, [want]);
  }

  /** Insert or replace a batch of records (one transaction). */
  upsert(records: VectorRecord[]): void {
    if (!records.length) return;
    const stmt = this.#db.prepare(
      `INSERT OR REPLACE INTO chunks (id, source, hash, heading, text, vector, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    const tx = this.#db.transaction((rows: VectorRecord[]) => {
      for (const r of rows) {
        stmt.run(r.id, r.source, r.hash, r.heading ?? "", r.text, encodeVector(r.vector), now);
      }
    });
    tx(records);
  }

  /** The set of chunk ids currently stored for a given source (for reconcile). */
  idsForSource(source: string): Set<string> {
    const rows = this.#db
      .query<{ id: string }, [string]>(`SELECT id FROM chunks WHERE source = ?`)
      .all(source);
    return new Set(rows.map((r) => r.id));
  }

  /** Delete chunks by id (no-op for an empty list). */
  deleteIds(ids: string[]): void {
    if (!ids.length) return;
    const stmt = this.#db.prepare(`DELETE FROM chunks WHERE id = ?`);
    const tx = this.#db.transaction((list: string[]) => {
      for (const id of list) stmt.run(id);
    });
    tx(ids);
  }

  /** Delete every chunk for sources NOT in `keep` (a file was removed/renamed). */
  pruneSourcesExcept(keep: Set<string>): void {
    const rows = this.#db.query<{ source: string }, []>(`SELECT DISTINCT source FROM chunks`).all();
    const dead = rows.map((r) => r.source).filter((s) => !keep.has(s));
    if (!dead.length) return;
    const stmt = this.#db.prepare(`DELETE FROM chunks WHERE source = ?`);
    const tx = this.#db.transaction((list: string[]) => {
      for (const s of list) stmt.run(s);
    });
    tx(dead);
  }

  /** Hard cap on rows scanned per query (BUG-066) — unbounded episodic growth
   * must not OOM `/recall`. Prefer newest chunks when over the cap. */
  static readonly MAX_SEARCH_ROWS = 50_000;

  /** Top-`k` chunks by cosine similarity to `queryVector` (brute-force, bounded). */
  search(queryVector: number[], k = 8): VectorHit[] {
    const rows = this.#db
      .query<{ id: string; source: string; heading: string; text: string; vector: Uint8Array }, []>(
        `SELECT id, source, heading, text, vector FROM chunks
         ORDER BY updated_at DESC
         LIMIT ${VectorStore.MAX_SEARCH_ROWS}`,
      )
      .all();
    const hits: VectorHit[] = [];
    for (const r of rows) {
      const score = cosineSimilarity(queryVector, decodeVector(r.vector));
      hits.push({ id: r.id, source: r.source, heading: r.heading, text: r.text, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /** Number of stored chunks. */
  count(): number {
    return this.#db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM chunks`).get()?.n ?? 0;
  }

  close(): void {
    this.#db.close();
  }
}

/** Encode a vector as a little-endian Float32 blob. */
function encodeVector(vector: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

/** Decode a Float32 blob back into a number[]. */
function decodeVector(blob: Uint8Array): number[] {
  // Copy to a fresh, 4-byte-aligned buffer (SQLite blobs may be offset views).
  const aligned = new Uint8Array(blob.length);
  aligned.set(blob);
  return Array.from(new Float32Array(aligned.buffer, 0, Math.floor(aligned.length / 4)));
}
