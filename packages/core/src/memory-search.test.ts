import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "./embeddings.ts";
import { openSemanticMemory } from "./semantic-memory.ts";
import { searchMemory } from "./memory-search.ts";

function spyEmbedder(dim = 64): Embedder {
  const one = (text: string): number[] => {
    const v = new Array(dim).fill(0);
    for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2)) {
      let h = 0;
      for (const ch of tok) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % dim] += 1;
    }
    return v;
  };
  return { id: "spy/embed", dimensions: dim, embed: async (texts) => texts.map(one) };
}

const SOURCES = [
  { source: "facts.md", text: "# Database\nthe project uses Postgres via Neon\n\n# Styling\nTailwind with a dark theme" },
];

test("lexical-only (no embedder) still finds a memory chunk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-"));
  const hits = await searchMemory({ cwd: dir, query: "Postgres Neon", sources: SOURCES, includeSessions: false });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.kind).toBe("memory");
  expect(hits[0]!.text).toContain("Postgres");
});

test("hybrid (lexical + dense) finds the relevant chunk and dedups across rankings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms2-"));
  const semantic = openSemanticMemory(dir, spyEmbedder(), ":memory:");
  const hits = await searchMemory({
    cwd: dir,
    query: "what database does the project use",
    sources: SOURCES,
    semantic,
    includeSessions: false,
  });
  expect(hits[0]!.text).toContain("Postgres");
  // A chunk that ranks in BOTH lexical and dense appears once, not twice.
  const ids = hits.map((h) => h.id);
  expect(new Set(ids).size).toBe(ids.length);
  semantic.close();
});

test("returns nothing when there is no corpus, no sessions, no embedder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms3-"));
  const hits = await searchMemory({ cwd: dir, query: "anything", sources: [], includeSessions: false });
  expect(hits).toEqual([]);
});
