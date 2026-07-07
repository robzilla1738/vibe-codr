import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "./embeddings.ts";
import { globalStateDir } from "./state-dir.ts";
import { openSemanticMemory, semanticIndexPath } from "./semantic-memory.ts";

/** Deterministic bag-of-words embedder: similar token sets → similar vectors,
 * so cosine search behaves like token overlap. Counts how many texts it embeds. */
function spyEmbedder(dim = 64): Embedder & { texts: number } {
  const one = (text: string): number[] => {
    const v = new Array(dim).fill(0);
    for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2)) {
      let h = 0;
      for (const ch of tok) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % dim] += 1;
    }
    return v;
  };
  const e = {
    id: "spy/embed",
    dimensions: dim,
    texts: 0,
    async embed(texts: string[]) {
      e.texts += texts.length;
      return texts.map(one);
    },
  };
  return e;
}

test("semanticIndexPath uses the global project state dir, not project .vibe", () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-semantic-path-"));
  expect(semanticIndexPath(cwd)).toBe(join(globalStateDir(cwd), "memory", "index.sqlite"));
  expect(semanticIndexPath(cwd)).not.toContain(join(cwd, ".vibe"));
});

test("indexes a corpus and finds the semantically nearest chunk", async () => {
  const embedder = spyEmbedder();
  const mem = openSemanticMemory(".", embedder, ":memory:");
  await mem.index([
    { source: "notes.md", text: "# Config\nthe config loader parses JSONC\n\n# Auth\nOAuth redirect flow" },
  ]);
  expect(mem.count()).toBe(2);
  const hits = await mem.search("config loader JSONC", 2);
  expect(hits[0]!.text).toContain("config loader");
  mem.close();
});

test("re-indexing only embeds new/changed chunks (idempotent + incremental)", async () => {
  const embedder = spyEmbedder();
  const mem = openSemanticMemory(".", embedder, ":memory:");
  await mem.index([{ source: "a.md", text: "# A\nalpha body\n\n# B\nbeta body" }]);
  expect(embedder.texts).toBe(2); // both chunks embedded once

  // Re-index identical content → nothing re-embedded.
  await mem.index([{ source: "a.md", text: "# A\nalpha body\n\n# B\nbeta body" }]);
  expect(embedder.texts).toBe(2);

  // Edit only section B → exactly one new embedding; count stays 2.
  await mem.index([{ source: "a.md", text: "# A\nalpha body\n\n# B\nGAMMA body" }]);
  expect(embedder.texts).toBe(3);
  expect(mem.count()).toBe(2);
  mem.close();
});

test("removing a source prunes its chunks from the index", async () => {
  const embedder = spyEmbedder();
  const mem = openSemanticMemory(".", embedder, ":memory:");
  await mem.index([
    { source: "keep.md", text: "# K\nkeep this" },
    { source: "drop.md", text: "# D\ndrop this" },
  ]);
  expect(mem.count()).toBe(2);
  await mem.index([{ source: "keep.md", text: "# K\nkeep this" }]); // drop.md gone
  expect(mem.count()).toBe(1);
  mem.close();
});
