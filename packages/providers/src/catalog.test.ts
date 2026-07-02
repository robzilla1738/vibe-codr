import { test, expect } from "bun:test";
import {
  parseModelsDev,
  resolveCatalogPrice,
  aliasModelKey,
  PROVIDER_SLUG_ALIASES,
  CatalogService,
} from "./catalog.ts";

test("resolveCatalogPrice: exact match is real, base-model match is estimated", () => {
  const meta = parseModelsDev({
    zhipuai: { models: { "glm-5.2": { cost: { input: 0.6, output: 2.2 } } } },
    anthropic: { models: { "claude-opus-4-8": { cost: { input: 5, output: 25 } } } },
  });
  // Exact provider/model hit → real price (no estimated flag).
  expect(resolveCatalogPrice(meta, "zhipuai/glm-5.2")).toEqual({ input: 0.6, output: 2.2 });
  // A different provider's tag for the same base model → estimated fallback.
  expect(resolveCatalogPrice(meta, "ollama/glm-5.2")).toEqual({
    input: 0.6,
    output: 2.2,
    estimated: true,
  });
  // Truly unknown model → undefined.
  expect(resolveCatalogPrice(meta, "ollama/nonesuch")).toBeUndefined();
});

test("parseModelsDev flattens provider/model metadata", () => {
  const raw = {
    anthropic: {
      models: {
        "claude-opus-4-8": {
          name: "Claude Opus 4.8",
          limit: { context: 200000, output: 64000 },
          cost: { input: 5, output: 25 },
          tool_call: true,
          reasoning: true,
          structured_output: true,
          modalities: { input: ["text", "image"] },
        },
      },
    },
  };
  const map = parseModelsDev(raw);
  const m = map.get("anthropic/claude-opus-4-8");
  expect(m?.id).toBe("claude-opus-4-8");
  expect(m?.providerId).toBe("anthropic");
  expect(m?.contextWindow).toBe(200000);
  expect(m?.maxOutput).toBe(64000);
  expect(m?.cost).toEqual({ input: 5, output: 25 });
  expect(m?.capabilities?.vision).toBe(true);
  expect(m?.capabilities?.toolCall).toBe(true);
});

test("vision is false when image is not among the input modalities", () => {
  const map = parseModelsDev({
    openai: { models: { "gpt-x": { modalities: { input: ["text"] } } } },
  });
  expect(map.get("openai/gpt-x")?.capabilities?.vision).toBe(false);
});

test("malformed input degrades to an empty map instead of throwing", () => {
  expect(parseModelsDev(null).size).toBe(0);
  expect(parseModelsDev("nonsense").size).toBe(0);
  expect(parseModelsDev({ p: { models: null } }).size).toBe(0);
});

test("aliasModelKey rewrites provider ids that differ from their models.dev slug", () => {
  // The exceptions (vibe id → catalog slug) are what make enrichment land.
  expect(aliasModelKey("together/Llama-3.3-70B")).toBe("togetherai/Llama-3.3-70B");
  expect(aliasModelKey("fireworks/x")).toBe("fireworks-ai/x");
  expect(aliasModelKey("codex/gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
  expect(aliasModelKey("moonshot/kimi-k2.7-code")).toBe("moonshotai/kimi-k2.7-code");
  // Hosted ollama.com models are cataloged under `ollama-cloud`.
  expect(aliasModelKey("ollama/glm-5.2")).toBe("ollama-cloud/glm-5.2");
  // Ids that already match models.dev pass through untouched.
  expect(aliasModelKey("openai/gpt-5.2")).toBe("openai/gpt-5.2");
  expect(aliasModelKey("google/gemini-2.5-pro")).toBe("google/gemini-2.5-pro");
  expect(aliasModelKey("no-slash")).toBe("no-slash");
  // Every alias target is a real models.dev-style slug (non-empty, no slash).
  for (const slug of Object.values(PROVIDER_SLUG_ALIASES)) {
    expect(slug.length).toBeGreaterThan(0);
    expect(slug).not.toContain("/");
  }
});

test("enrich resolves metadata through the alias (fireworks → fireworks-ai)", async () => {
  const cat = new CatalogService();
  const raw = {
    "fireworks-ai": {
      models: {
        "accounts/fireworks/models/deepseek-v4-pro": {
          name: "DeepSeek V4 Pro",
          limit: { context: 160000 },
          cost: { input: 0.9, output: 0.9 },
        },
      },
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL) =>
    new Response(JSON.stringify(raw), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    await cat.refresh(); // force a fetch of our fixture
    const [enriched] = await cat.enrich([
      { id: "accounts/fireworks/models/deepseek-v4-pro", providerId: "fireworks" },
    ]);
    // The live `fireworks/...` id picked up `fireworks-ai/...` metadata via the alias.
    expect(enriched?.contextWindow).toBe(160000);
    expect(enriched?.name).toBe("DeepSeek V4 Pro");
    expect(enriched?.providerId).toBe("fireworks"); // live id wins
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failed first load does NOT poison the catalog — a later lookup retries", async () => {
  // Regression: the first load caching an empty Map (truthy) made every later
  // contextWindow()/pricing()/enrich() skip the network forever, pinning all
  // models to defaults for the process lifetime.
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const prevCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "vibe-cat-")); // fresh, empty → no cache file
  const realFetch = globalThis.fetch;
  let failNext = true;
  globalThis.fetch = (async (_url: string | URL) => {
    if (failNext) throw new Error("offline");
    return new Response(JSON.stringify({ openai: { models: { "gpt-5.2": { limit: { context: 400000 } } } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const cat = new CatalogService();
    // First load fails (offline, no cache) → empty enrichment, but NOT poisoned.
    const first = await cat.enrich([{ providerId: "openai", id: "gpt-5.2" }]);
    expect(first[0]!.contextWindow).toBeUndefined();
    // Network recovers → the next load must retry and pick up the real value.
    failNext = false;
    const second = await cat.enrich([{ providerId: "openai", id: "gpt-5.2" }]);
    expect(second[0]!.contextWindow).toBe(400000);
  } finally {
    globalThis.fetch = realFetch;
    if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prevCache;
  }
});

test("refresh() force-fetches the catalog and returns the model count", async () => {
  const cat = new CatalogService();
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL) => {
    calls++;
    return new Response(
      JSON.stringify({ openai: { models: { "gpt-5.2": {}, "gpt-5.2-codex": {} } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    expect(await cat.refresh()).toBe(2);
    await cat.refresh(); // bypasses the 24h cache every time
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
