import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { MockEmbeddingModelV3 } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig, type Config } from "@vibe/config";
import { MemoryService } from "./memory-service.ts";
import { semanticIndexPath } from "./semantic-memory.ts";
import { projectMemoryDir } from "./memory-store.ts";
import { SessionStore, type SessionMeta } from "./store.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "vibe-msvc-"));
}

/** A bag-of-words mock embedding so cosine reflects token overlap. */
function bagOfWordsEmbedding(dim = 64, seen: string[] = []) {
  return new MockEmbeddingModelV3({
    doEmbed: async ({ values }: { values: string[] }) => ({
      embeddings: values.map((text) => {
        seen.push(text);
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
      }),
      usage: { tokens: values.length },
      warnings: [],
    }),
  });
}

function semanticRegistry(seen: string[] = []): ProviderRegistry {
  return new ProviderRegistry([
    {
      id: "fake",
      auth: { env: [], keyless: true },
      create: () => {
        throw new Error("chat not supported");
      },
      createEmbedding: () => bagOfWordsEmbedding(64, seen),
      listModels: async () => [],
    },
  ]);
}

function withMemory(model: string): Config {
  const base = defaultConfig();
  return { ...base, memory: { ...base.memory, semantic: { enabled: model !== "off", model } } };
}

test("MemoryService works without an embedder (lexical) and round-trips a saved fact", async () => {
  const dir = freshDir();
  const svc = await MemoryService.create(dir, withMemory("off"), new ProviderRegistry());
  expect(svc.semanticEnabled).toBe(false);
  await svc.save({ fact: "the build uses turborepo with bun workspaces" });
  const hits = await svc.search("turborepo build");
  expect(hits.some((h) => h.text.includes("turborepo"))).toBe(true);
  svc.close();
});

test("MemoryService with an embedder does semantic recall over saved memory", async () => {
  const dir = freshDir();
  const registry = semanticRegistry();
  const svc = await MemoryService.create(dir, withMemory("fake/embed"), registry);
  expect(svc.semanticEnabled).toBe(true);
  await svc.save({ fact: "the database is Postgres hosted on Neon" });
  const hits = await svc.search("database Postgres Neon");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.text).toContain("Postgres");
  svc.close();
});

test("save embeds a compact digest immediately and incrementally, never raw session history", async () => {
  const dir = freshDir();
  const seen: string[] = [];
  const store = new SessionStore(dir);
  const meta: SessionMeta = {
    id: "ses_raw_history",
    model: "fake/chat",
    mode: "execute",
    goal: null,
    createdAt: 1,
    updatedAt: 2,
  };
  await store.save(
    meta,
    [
      { role: "user", content: "RAW_TRANSCRIPT_SECRET deployment discussion" },
      { role: "assistant", content: "completed" },
    ],
    [
      {
        id: "u",
        role: "user",
        parts: [{ type: "text", text: "RAW_TRANSCRIPT_SECRET deployment discussion" }],
        createdAt: 1,
      },
      { id: "a", role: "assistant", parts: [{ type: "text", text: "completed" }], createdAt: 2 },
    ],
  );

  const svc = await MemoryService.create(dir, withMemory("fake/embed"), semanticRegistry(seen));
  const probeCount = seen.length;
  const longDigest = Array.from({ length: 100 }, (_, i) => `digestword${i}`).join(" ");
  await svc.save({ fact: longDigest, tags: ["session-digest"] });
  // The date-file title plus the digest chunk are indexed during save, before
  // any search. The persisted digest body itself is hard-capped to 80 words.
  expect(seen).toHaveLength(probeCount + 2);
  const indexedDigest = seen.find((text) => text.includes("digestword0"))!;
  expect(indexedDigest).toContain("digestword79");
  expect(indexedDigest).not.toContain("digestword80");
  expect(seen.join(" ")).not.toContain("RAW_TRANSCRIPT_SECRET");

  await svc.save({ fact: "second compact durable decision", tags: ["session-digest"] });
  expect(seen).toHaveLength(probeCount + 3); // unchanged title + first digest were not re-embedded
  await svc.search("deployment");
  expect(seen.join(" ")).not.toContain("RAW_TRANSCRIPT_SECRET");
  svc.close();
});

test("empty-corpus reconciliation prunes the final semantic vector", async () => {
  const dir = freshDir();
  const svc = await MemoryService.create(dir, withMemory("fake/embed"), semanticRegistry());
  await svc.save({ fact: "temporary semantic memory" });
  const db = new Database(semanticIndexPath(dir));
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get()?.n).toBe(2);

  await rm(projectMemoryDir(dir), { recursive: true, force: true });
  await svc.reconcile();
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get()?.n).toBe(0);
  db.close();
  svc.close();
});

test("service pin, forget, and merge keep the live corpus authoritative", async () => {
  const dir = freshDir();
  const svc = await MemoryService.create(dir, withMemory("off"), new ProviderRegistry());
  await svc.save({ fact: "first deployment decision" });
  await svc.save({ fact: "second deployment gotcha" });
  const entries = await svc.listEntries();
  expect(entries).toHaveLength(2);

  const first = await svc.setPinned(entries[0]!.id.slice(0, 6), true);
  expect(first.pinned).toBe(true);
  const merged = await svc.merge(
    entries.map((entry) => entry.id.slice(0, 6)),
    "Deployment uses the first decision and accounts for the second gotcha.",
  );
  expect(merged.removed.map((entry) => entry.id).sort()).toEqual(
    entries.map((entry) => entry.id).sort(),
  );
  expect(merged.replacement).toMatchObject({ scope: "project", pinned: true });
  const remaining = await svc.listEntries();
  expect(remaining).toHaveLength(1);
  expect(remaining[0]!.id).toBe(merged.replacement.id);

  await svc.forget(remaining[0]!.id);
  expect(await svc.listEntries()).toEqual([]);
  svc.close();
});

test("merge preserves originals when the replacement already exists", async () => {
  const dir = freshDir();
  const svc = await MemoryService.create(dir, withMemory("off"), new ProviderRegistry());
  await svc.save({ fact: "existing replacement" });
  await svc.save({ fact: "merge source alpha" });
  await svc.save({ fact: "merge source beta" });
  const before = await svc.listEntries();
  const sources = before.filter((entry) => entry.fact.startsWith("merge source"));
  await expect(
    svc.merge(
      sources.map((entry) => entry.id),
      "existing replacement",
    ),
  ).rejects.toThrow("originals were preserved");
  expect((await svc.listEntries()).map((entry) => entry.id).sort()).toEqual(
    before.map((entry) => entry.id).sort(),
  );
  svc.close();
});
