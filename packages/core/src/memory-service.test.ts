import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEmbeddingModelV2 } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig, type Config } from "@vibe/config";
import { MemoryService } from "./memory-service.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "vibe-msvc-"));
}

/** A bag-of-words mock embedding so cosine reflects token overlap. */
function bagOfWordsEmbedding(dim = 64) {
  return new MockEmbeddingModelV2({
    doEmbed: async ({ values }: { values: string[] }) => ({
      embeddings: values.map((text) => {
        const v = new Array(dim).fill(0);
        for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2)) {
          let h = 0;
          for (const ch of tok) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          v[h % dim] += 1;
        }
        return v;
      }),
      usage: { tokens: values.length },
    }),
  });
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
  const registry = new ProviderRegistry([
    {
      id: "fake",
      auth: { env: [], keyless: true },
      create: () => {
        throw new Error("chat not supported");
      },
      createEmbedding: () => bagOfWordsEmbedding(),
      listModels: async () => [],
    },
  ]);
  const svc = await MemoryService.create(dir, withMemory("fake/embed"), registry);
  expect(svc.semanticEnabled).toBe(true);
  await svc.save({ fact: "the database is Postgres hosted on Neon" });
  const hits = await svc.search("database Postgres Neon");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.text).toContain("Postgres");
  svc.close();
});
