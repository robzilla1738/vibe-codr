import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore, type VectorRecord } from "./vector-store.ts";

function rec(id: string, vector: number[], source = "m.md"): VectorRecord {
  return { id, source, hash: id, heading: "h", text: `text ${id}`, vector };
}

test("search ranks by cosine similarity to the query vector", () => {
  const store = new VectorStore(":memory:", "fake", 2);
  store.upsert([
    rec("east", [1, 0]),
    rec("north", [0, 1]),
    rec("northeast", [1, 1]),
  ]);
  const hits = store.search([1, 0.1], 3);
  expect(hits[0]!.id).toBe("east"); // closest to the query direction
  expect(hits.map((h) => h.id)).toContain("northeast");
  expect(hits[0]!.score).toBeGreaterThan(hits[2]!.score);
  store.close();
});

test("idsForSource + deleteIds support incremental reconcile", () => {
  const store = new VectorStore(":memory:", "fake", 2);
  store.upsert([rec("a", [1, 0]), rec("b", [0, 1]), rec("c", [1, 1], "other.md")]);
  expect(store.idsForSource("m.md")).toEqual(new Set(["a", "b"]));
  store.deleteIds(["a"]);
  expect(store.idsForSource("m.md")).toEqual(new Set(["b"]));
  expect(store.count()).toBe(2);
  store.close();
});

test("pruneSourcesExcept drops chunks from removed files only", () => {
  const store = new VectorStore(":memory:", "fake", 2);
  store.upsert([rec("a", [1, 0], "keep.md"), rec("b", [0, 1], "gone.md")]);
  store.pruneSourcesExcept(new Set(["keep.md"]));
  expect(store.count()).toBe(1);
  expect(store.idsForSource("gone.md").size).toBe(0);
  expect(store.idsForSource("keep.md").size).toBe(1);
  store.close();
});

test("switching the embedder (model or dim) transparently rebuilds the index", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-vec-"));
  const path = join(dir, "index.sqlite");
  const a = new VectorStore(path, "model-a", 2);
  a.upsert([rec("x", [1, 0])]);
  expect(a.count()).toBe(1);
  a.close();
  // Reopen with the SAME embedder → data persists.
  const same = new VectorStore(path, "model-a", 2);
  expect(same.count()).toBe(1);
  same.close();
  // Reopen with a DIFFERENT embedder → stale vectors cleared.
  const b = new VectorStore(path, "model-b", 2);
  expect(b.count()).toBe(0);
  b.close();
});

test("vectors survive a round-trip through the float32 blob", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-vec2-"));
  const path = join(dir, "index.sqlite");
  const v = [0.123_45, -0.678_9, 0.000_1, 1];
  const store = new VectorStore(path, "m", 4);
  store.upsert([rec("p", v)]);
  store.close();
  const reopened = new VectorStore(path, "m", 4);
  // Querying with the exact stored vector returns it at ~1.0 similarity.
  const [hit] = reopened.search(v, 1);
  expect(hit!.id).toBe("p");
  expect(hit!.score).toBeCloseTo(1, 5);
  reopened.close();
});
