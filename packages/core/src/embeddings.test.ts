import { test, expect } from "bun:test";
import { MockEmbeddingModelV2 } from "ai/test";
import { ProviderRegistry } from "@vibe/providers";
import { defaultConfig } from "@vibe/config";
import { aiSdkEmbedder, resolveEmbedder, cosineSimilarity } from "./embeddings.ts";

/** Deterministic 3-dim mock: vector keyed by the input's first char code. */
function mockEmbedding(dim = 3) {
  return new MockEmbeddingModelV2({
    doEmbed: async ({ values }: { values: string[] }) => ({
      embeddings: values.map((v) => {
        const c = (v.charCodeAt(0) || 1) % 7;
        return Array.from({ length: dim }, (_, i) => Math.sin(c + i));
      }),
      usage: { tokens: values.length },
    }),
  });
}

test("cosineSimilarity: identical=1, orthogonal=0, opposite=-1", () => {
  expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
  expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  expect(cosineSimilarity([0, 0], [1, 1])).toBe(0); // degenerate
});

test("aiSdkEmbedder wraps an embedding model and returns one vector per input", async () => {
  const e = aiSdkEmbedder("mock/embed", mockEmbedding());
  const vecs = await e.embed(["alpha", "beta"]);
  expect(vecs).toHaveLength(2);
  expect(vecs[0]).toHaveLength(3);
  expect(await e.embed([])).toEqual([]);
});

test("resolveEmbedder returns undefined when semantic memory is disabled", async () => {
  const config = { ...defaultConfig(), memory: { ...defaultConfig().memory, semantic: { enabled: false, model: "local" } } };
  expect(await resolveEmbedder(config, new ProviderRegistry())).toBeUndefined();
});

test("resolveEmbedder returns undefined (graceful) when the embedder errs", async () => {
  // An unknown provider → embeddingModel throws → caught → undefined (no network).
  const config = {
    ...defaultConfig(),
    memory: { ...defaultConfig().memory, semantic: { enabled: true, model: "noprovider/embed" } },
  };
  expect(await resolveEmbedder(config, new ProviderRegistry())).toBeUndefined();
});

test("resolveEmbedder builds a working embedder + learns dimensions from the probe", async () => {
  // A fake provider whose createEmbedding returns the deterministic mock.
  const registry = new ProviderRegistry([
    {
      id: "fake",
      auth: { env: [], keyless: true },
      create: () => {
        throw new Error("not a chat model");
      },
      createEmbedding: () => mockEmbedding(5),
      listModels: async () => [],
    },
  ]);
  const config = {
    ...defaultConfig(),
    memory: { ...defaultConfig().memory, semantic: { enabled: true, model: "fake/embed-1" } },
  };
  const embedder = await resolveEmbedder(config, registry);
  expect(embedder).toBeDefined();
  expect(embedder!.dimensions).toBe(5); // learned from the probe vector
  expect(embedder!.id).toBe("fake/embed-1");
});
