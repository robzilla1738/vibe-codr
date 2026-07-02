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

/**
 * A concept embedder: maps a handful of synonym families to shared dimensions, so
 * a paraphrase that shares ZERO surface tokens with the query still lands on the
 * same vector (true semantic match — a bag-of-words hash embedder cannot model
 * this). Used to prove the dense branch survives the lexical relevance floor.
 */
function conceptEmbedder(): Embedder {
  const families: RegExp[] = [
    /\b(car|cars|automobile|automobiles|vehicle|motorcar)\b/,
    /\b(fast|quick|quickly|speedy|rapid|swift)\b/,
  ];
  const vec = (text: string): number[] => {
    const t = text.toLowerCase();
    return families.map((re) => (re.test(t) ? 1 : 0));
  };
  return { id: "concept/embed", dimensions: families.length, embed: async (texts) => texts.map(vec) };
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

test("relevance floor: a junk-overlap-only query (one incidental token) injects NOTHING", async () => {
  // A long (proactive-seed-like) query whose ONLY corpus overlap is a single
  // incidental token — the floor demands ≥ 2 distinct-term overlap for a ≥ 4-term
  // query, so the junk chunk is dropped and recall surfaces nothing (honest empty).
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-floor-junk-"));
  const sources = [
    { source: "notes.md", text: "# Notes\nthe frontend deployment uses a static bundle and a cdn cache" },
  ];
  const hits = await searchMemory({
    cwd: dir,
    query: "kubernetes helm chart deployment rollout",
    sources,
    includeSessions: false,
  });
  expect(hits).toEqual([]);
});

test("relevance floor: a strong match still injects; the junk chunk beside it is dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-floor-strong-"));
  const sources = [
    { source: "deploy.md", text: "# Deploy\nkubernetes helm chart rollout via argo cd" },
    { source: "notes.md", text: "# Notes\nthe frontend deployment uses a static bundle" },
  ];
  const hits = await searchMemory({
    cwd: dir,
    query: "kubernetes helm chart deployment rollout",
    sources,
    includeSessions: false,
  });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.text).toContain("helm");
  // The one-token-overlap junk chunk must NOT ride along.
  expect(hits.some((h) => h.text.includes("static bundle"))).toBe(false);
});

test("relevance floor: a zero-surface-overlap paraphrase still surfaces via the dense branch", async () => {
  // The query and the chunk share NO tokens ("fast car" vs "automobile … quick"),
  // so the lexical overlap gate would drop the chunk — nullifying exactly the
  // paraphrase recall semantic search exists for. The dense branch ranked it, so
  // it must be exempt from the lexical floor and survive.
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-floor-dense-"));
  const semantic = openSemanticMemory(dir, conceptEmbedder(), ":memory:");
  const sources = [
    { source: "vehicle.md", text: "# Vehicle\nthe automobile is quick and handles well" },
  ];
  const hits = await searchMemory({
    cwd: dir,
    query: "fast car",
    sources,
    semantic,
    includeSessions: false,
  });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.text).toContain("automobile");
  semantic.close();
});

test("relevance floor: the RRF path is unaffected on a healthy query (no embedder)", async () => {
  // A normal query where every hit is genuinely relevant — the floor is a no-op,
  // so both chunks come back in RRF order (most-relevant first), exactly as before.
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-floor-healthy-"));
  const sources = [
    { source: "db.md", text: "# Postgres\nthe project uses postgres via neon serverless\n\n# Pooling\npostgres neon connection pooling with pgbouncer" },
  ];
  const hits = await searchMemory({
    cwd: dir,
    query: "postgres neon pooling",
    sources,
    includeSessions: false,
  });
  expect(hits).toHaveLength(2);
  // The chunk matching all three terms outranks the two-term one — RRF intact.
  expect(hits[0]!.text).toContain("pgbouncer");
  expect(hits.some((h) => h.text.includes("serverless"))).toBe(true);
});
