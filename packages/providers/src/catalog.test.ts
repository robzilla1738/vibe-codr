import { test, expect } from "bun:test";
import {
  parseModelsDev,
  resolveCatalogPrice,
  resolveCatalogWindow,
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
  // A non-local provider's tag for the same base model → estimated fallback.
  expect(resolveCatalogPrice(meta, "openrouter/glm-5.2")).toEqual({
    input: 0.6,
    output: 2.2,
    estimated: true,
  });
  // Truly unknown model → undefined.
  expect(resolveCatalogPrice(meta, "openrouter/nonesuch")).toBeUndefined();
});

test("resolveCatalogPrice: local ollama/lmstudio never inherit cloud rates as real (BUG-102)", () => {
  const meta = parseModelsDev({
    zhipuai: { models: { "glm-5.2": { cost: { input: 0.6, output: 2.2 } } } },
    "ollama-cloud": { models: { "glm-5.2": { cost: { input: 1.0, output: 3.0 } } } },
  });
  const hadKey = process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  try {
    // No cloud signal: free local tags must not get ollama-cloud rates (real)
    // nor a fuzzy base-model match (estimated) — either path can hard-stop
    // a free session under budget.onExceed=stop.
    expect(resolveCatalogPrice(meta, "ollama/glm-5.2")).toBeUndefined();
    expect(resolveCatalogPrice(meta, "lmstudio/glm-5.2")).toBeUndefined();
    // With the cloud signal, ollama aliases to ollama-cloud for real prices.
    process.env.OLLAMA_API_KEY = "test-key";
    expect(resolveCatalogPrice(meta, "ollama/glm-5.2")).toEqual({ input: 1.0, output: 3.0 });
  } finally {
    if (hadKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = hadKey;
  }
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

test("parseModelsDev coerces a non-numeric/NaN/Infinity price to undefined (adversarial P5-W2)", () => {
  // A malformed models.dev upstream (a string / NaN / Infinity price) must NOT flow
  // into cost math: a NaN cost accumulates into the running spend and makes every
  // `costUSD > limitUSD` comparison false, silently disabling the budget `stop` cap.
  const map = parseModelsDev({
    bad: {
      models: {
        m: {
          cost: {
            input: "high", // string
            output: null, // null
            cache_read: Number.POSITIVE_INFINITY, // non-finite
            cache_write: 0.3, // the one real number survives
            tiers: [{ input: "nope", output: 40, tier: { type: "context", size: 200000 } }],
          },
        },
      },
    },
  });
  const cost = map.get("bad/m")?.cost;
  expect(cost?.input).toBeUndefined();
  expect(cost?.output).toBeUndefined();
  expect(cost?.cacheRead).toBeUndefined();
  expect(cost?.cacheWrite).toBe(0.3);
  // Tier prices are coerced too: the bad `input` drops, the real `output` stays.
  expect(cost?.tiers).toEqual([{ threshold: 200000, input: undefined, output: 40, cacheRead: undefined, cacheWrite: undefined }]);
});

test("parseModelsDev captures long-context pricing tiers from cost.tiers", () => {
  // Faithful wire shape: tiers carry their REAL threshold via tier.size (272k for
  // GPT-5.x, not the lossy 200k of the context_over_200k sibling).
  const map = parseModelsDev({
    openai: {
      models: {
        "gpt-5.5": {
          cost: {
            input: 5,
            output: 30,
            cache_read: 0.5,
            tiers: [
              { input: 10, output: 45, cache_read: 1, tier: { type: "context", size: 272000 } },
            ],
            context_over_200k: { input: 10, output: 45, cache_read: 1 },
          },
        },
      },
    },
  });
  expect(map.get("openai/gpt-5.5")?.cost?.tiers).toEqual([
    { threshold: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: undefined },
  ]);
});

test("parseModelsDev falls back to context_over_200k when cost.tiers is absent", () => {
  const map = parseModelsDev({
    xai: {
      models: {
        "grok-legacy": {
          cost: { input: 1.25, output: 2.5, context_over_200k: { input: 2.5, output: 5, cache_read: 0.4 } },
        },
      },
    },
  });
  expect(map.get("xai/grok-legacy")?.cost?.tiers).toEqual([
    { threshold: 200_000, input: 2.5, output: 5, cacheRead: 0.4, cacheWrite: undefined },
  ]);
});

test("parseModelsDev leaves flat-rate models without a tiers field", () => {
  const map = parseModelsDev({
    anthropic: { models: { "claude-opus-4-8": { cost: { input: 5, output: 25 } } } },
  });
  expect(map.get("anthropic/claude-opus-4-8")?.cost?.tiers).toBeUndefined();
});

test("resolveCatalogPrice carries tiers through on both exact and estimated matches", () => {
  const meta = parseModelsDev({
    google: {
      models: {
        "gemini-3.1-pro-preview": {
          cost: {
            input: 2,
            output: 12,
            cache_read: 0.2,
            tiers: [
              { input: 4, output: 18, cache_read: 0.4, tier: { type: "context", size: 200000 } },
            ],
          },
        },
      },
    },
  });
  // Exact hit keeps the tiers.
  expect(resolveCatalogPrice(meta, "google/gemini-3.1-pro-preview")?.tiers).toEqual([
    { threshold: 200_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: undefined },
  ]);
  // A base-model estimate (different provider tag) still carries the tiers.
  const est = resolveCatalogPrice(meta, "vertex/gemini-3.1-pro-preview");
  expect(est?.estimated).toBe(true);
  expect(est?.tiers?.[0]?.threshold).toBe(200_000);
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

test("a malformed 200 does NOT poison the catalog (memory or disk) — a later good fetch enriches", async () => {
  // Regression: a wrong-shaped 200 (schema change / error envelope) parsed to an
  // empty map that was set as truthy #metadata AND written to the 24h disk cache,
  // pinning every model to defaults for a full day even across restarts.
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const prevCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "vibe-cat-bad-"));
  const realFetch = globalThis.fetch;
  let bad = true;
  globalThis.fetch = (async (_url: string | URL) => {
    if (bad) return new Response(JSON.stringify({ unexpected: "shape" }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ openai: { models: { "gpt-5.2": { limit: { context: 400000 } } } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const cat = new CatalogService();
    const first = await cat.enrich([{ providerId: "openai", id: "gpt-5.2" }]);
    expect(first[0]!.contextWindow).toBeUndefined(); // malformed → no enrichment…
    bad = false;
    const second = await cat.enrich([{ providerId: "openai", id: "gpt-5.2" }]);
    expect(second[0]!.contextWindow).toBe(400000); // …but NOT poisoned; retries and enriches
    // And a fresh service on the SAME cache dir isn't stuck on a cached bad body.
    const fresh = new CatalogService();
    const third = await fresh.enrich([{ providerId: "openai", id: "gpt-5.2" }]);
    expect(third[0]!.contextWindow).toBe(400000);
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

test("resolveCatalogWindow: exact hit wins; base-model fallback covers variants", () => {
  const meta = parseModelsDev({
    openai: { models: { "gpt-5.5": { limit: { context: 272_000, output: 128_000 } } } },
    zhipuai: { models: { "glm-5.2": { limit: { context: 200_000, output: 128_000 } } } },
  });
  expect(resolveCatalogWindow(meta, "openai/gpt-5.5")).toBe(272_000);
  // A variant/fine-tune tag of a known base model inherits its family's real
  // window — far better than the session's blanket 128k default.
  expect(resolveCatalogWindow(meta, "azure/gpt-5.5:my-deployment")).toBe(272_000);
  expect(resolveCatalogWindow(meta, "openai/nonesuch")).toBeUndefined();
});

test("resolveCatalogWindow: locally-probed providers never get a fuzzy window", () => {
  const meta = parseModelsDev({
    zhipuai: { models: { "glm-5.2": { limit: { context: 200_000, output: 128_000 } } } },
    "ollama-cloud": { models: { "glm-5.2": { limit: { context: 256_000, output: 64_000 } } } },
  });
  const hadKey = process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  try {
    // No cloud signal: a local ollama tag must NOT read its cloud namesake's
    // window (the alias is skipped) nor a base-model match — the live probe is
    // the source of truth for locally served models, and over-reporting means
    // compaction never fires.
    expect(resolveCatalogWindow(meta, "ollama/glm-5.2")).toBeUndefined();
    expect(resolveCatalogWindow(meta, "lmstudio/glm-5.2")).toBeUndefined();
    // With the cloud signal set, the alias is trustworthy again.
    process.env.OLLAMA_API_KEY = "test-key";
    expect(resolveCatalogWindow(meta, "ollama/glm-5.2")).toBe(256_000);
  } finally {
    if (hadKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = hadKey;
  }
});
