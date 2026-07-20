import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "./embeddings.ts";
import { openSemanticMemory } from "./semantic-memory.ts";
import { formatMemoryHits, searchMemory } from "./memory-search.ts";

function spyEmbedder(dim = 64): Embedder {
  const one = (text: string): number[] => {
    const v = new Array(dim).fill(0);
    for (const tok of text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2)) {
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
  return {
    id: "concept/embed",
    dimensions: families.length,
    embed: async (texts) => texts.map(vec),
  };
}

const SOURCES = [
  {
    source: "facts.md",
    text: "# Database\nthe project uses Postgres via Neon\n\n# Styling\nTailwind with a dark theme",
  },
];

test("lexical-only (no embedder) still finds a memory chunk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-"));
  const hits = await searchMemory({
    cwd: dir,
    query: "Postgres Neon",
    sources: SOURCES,
    includeSessions: false,
  });
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
  const hits = await searchMemory({
    cwd: dir,
    query: "anything",
    sources: [],
    includeSessions: false,
  });
  expect(hits).toEqual([]);
});

test("relevance floor: a junk-overlap-only query (one incidental token) injects NOTHING", async () => {
  // A long (proactive-seed-like) query whose ONLY corpus overlap is a single
  // incidental token — the floor demands ≥ 2 distinct-term overlap for a ≥ 4-term
  // query, so the junk chunk is dropped and recall surfaces nothing (honest empty).
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-floor-junk-"));
  const sources = [
    {
      source: "notes.md",
      text: "# Notes\nthe frontend deployment uses a static bundle and a cdn cache",
    },
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
    {
      source: "db.md",
      text: "# Postgres\nthe project uses postgres via neon serverless\n\n# Pooling\npostgres neon connection pooling with pgbouncer",
    },
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

test("proactive mode: a weak website digest does NOT inject on a visual-rebuild ask", async () => {
  // Repro of the Friendly-Bookkeeping derail: prior session digest about a world-cup
  // site shares only make/website-class tokens with "make a website that looks like
  // these images". Explicit floor (minOverlap 2) can still leak; proactive needs ≥3.
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-proactive-junk-"));
  const sources = [
    {
      source: "digest.md",
      text:
        "Session digest: built a world cup match results website with lineups and scores; " +
        "searched yesterday's fixtures and rendered a simple Next.js page.",
    },
  ];
  const query = "make a website that looks like these images";
  const proactive = await searchMemory({
    cwd: dir,
    query,
    sources,
    includeSessions: false,
    mode: "proactive",
  });
  expect(proactive).toEqual([]);
});

test("proactive mode: a strong multi-term match still injects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-proactive-strong-"));
  const sources = [
    {
      source: "db.md",
      text: "Chose Neon Postgres for the database because serverless connection pooling with pgbouncer.",
    },
  ];
  const hits = await searchMemory({
    cwd: dir,
    query: "postgres neon database pooling",
    sources,
    includeSessions: false,
    mode: "proactive",
  });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.text.toLowerCase()).toContain("postgres");
});

test("proactive mode: weak dense nearest-neighbour does not bypass the floor", async () => {
  // Axis embedder: every distinct string gets an orthogonal one-hot vector →
  // cosine 0 between query and docs. Explicit mode still exempts dense-ranked
  // ids; proactive requires min cosine and must drop the junk.
  const axisEmbedder = (): Embedder => {
    const axes = new Map<string, number>();
    let n = 0;
    return {
      id: "axis/embed",
      dimensions: 16,
      embed: async (texts) =>
        texts.map((t) => {
          if (!axes.has(t)) axes.set(t, n++);
          const v = new Array(16).fill(0);
          v[(axes.get(t) ?? 0) % 16] = 1;
          return v;
        }),
    };
  };
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-proactive-dense-"));
  const semantic = openSemanticMemory(dir, axisEmbedder(), ":memory:");
  const sources = [
    { source: "noise.md", text: "# Noise\nunrelated prior note about shipping a calendar widget" },
  ];
  const query = "fast car performance tuning";
  const explicit = await searchMemory({
    cwd: dir,
    query,
    sources,
    semantic,
    includeSessions: false,
    mode: "explicit",
  });
  // Dense ranks the only chunk; explicit exempts it despite zero surface overlap.
  expect(explicit.length).toBeGreaterThan(0);

  const proactive = await searchMemory({
    cwd: dir,
    query,
    sources,
    semantic,
    includeSessions: false,
    mode: "proactive",
  });
  expect(proactive).toEqual([]);
  semantic.close();
});

test("proactive mode: strong dense paraphrase still injects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-proactive-dense-ok-"));
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
    mode: "proactive",
  });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.text).toContain("automobile");
  semantic.close();
});

test("dated memory gets a modest freshness tie-break while retaining source provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-fresh-"));
  const hits = await searchMemory({
    cwd: dir,
    query: "postgres neon pooling",
    sources: [
      { source: ".vibe/memory/2024-01-01.md", text: "# DB\npostgres neon pooling" },
      { source: ".vibe/memory/2026-07-01.md", text: "# DB\npostgres neon pooling" },
    ],
    includeSessions: false,
    now: Date.parse("2026-07-20T00:00:00Z"),
  });
  expect(hits.map((hit) => hit.source)).toEqual([
    ".vibe/memory/2026-07-01.md",
    ".vibe/memory/2024-01-01.md",
  ]);
  expect(hits[0]!.provenance).toMatchObject({
    source: ".vibe/memory/2026-07-01.md",
    scope: "project",
    createdAt: Date.parse("2026-07-01T00:00:00.000Z"),
  });
  expect(formatMemoryHits("postgres", hits)).toContain(".vibe/memory/2026-07-01.md");
});

test("pinned old memory is freshness-protected without letting weaker fresh hits outrank relevance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-pinned-"));
  const hits = await searchMemory({
    cwd: dir,
    query: "postgres neon pooling",
    sources: [
      {
        source: ".vibe/memory/2024-01-01.md",
        text: "# DB\npostgres neon pooling pgbouncer\n_(pinned, database)_",
      },
      {
        source: ".vibe/memory/2026-07-01.md",
        text: "# DB\npostgres neon",
      },
    ],
    includeSessions: false,
    now: Date.parse("2026-07-20T00:00:00Z"),
  });
  expect(hits[0]!.source).toBe(".vibe/memory/2024-01-01.md");
  expect(hits[0]!.provenance.pinned).toBe(true);
});

test("freshness never lets a weaker new note outrank a materially stronger old note", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-ms-fresh-relevance-"));
  const hits = await searchMemory({
    cwd: dir,
    query: "postgres neon pooling pgbouncer",
    sources: [
      {
        source: ".vibe/memory/2024-01-01.md",
        text: "# Exact\npostgres neon pooling pgbouncer configuration",
      },
      { source: ".vibe/memory/2026-07-01.md", text: "# Partial\npostgres neon" },
    ],
    includeSessions: false,
    now: Date.parse("2026-07-20T00:00:00Z"),
  });
  expect(hits[0]!.source).toBe(".vibe/memory/2024-01-01.md");
});
