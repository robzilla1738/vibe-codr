import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import type { UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig, globalConfigPath } from "@vibe/config";
import { Engine } from "./engine.ts";

/** Run `fn` with the global config pointed at a throwaway dir, then read the
 *  persisted config to assert exactly what was written. Uses XDG_CONFIG_HOME (not
 *  HOME — Bun's os.homedir() caches at startup); restores it after. */
async function withTempHome<T>(fn: (readConfig: () => Promise<any>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "vibe-picker-xdg-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return await fn(async () => {
      try {
        return JSON.parse(await Bun.file(globalConfigPath()).text());
      } catch {
        return {};
      }
    });
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
}

function makeEngine(registry?: ProviderRegistry): Engine {
  return new Engine({
    config: { ...defaultConfig(), model: "mock/test" },
    ...(registry ? { registry, toolset: new Toolset([]) } : {}),
    cwd: mkdtempSync(join(tmpdir(), "vibe-picker-")),
  });
}

function collect(engine: Engine): UIEvent[] {
  const events: UIEvent[] = [];
  void (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  return events;
}

// Persistence is fire-and-forget (the in-memory config + snapshot update
// synchronously; the disk write is awaited inside the handler, not by the
// caller). Give the local file write a beat to land before reading it back.
const settle = () => new Promise((r) => setTimeout(r, 60));

test("set-subagent-model sets + persists, and null clears it (snapshot + disk)", async () => {
  await withTempHome(async (readConfig) => {
    const engine = makeEngine();
    collect(engine);

    engine.send({ type: "set-subagent-model", model: "openai/o4-mini" });
    await engine.whenIdle();
    await settle();
    expect(engine.snapshot().subagentModel).toBe("openai/o4-mini");
    expect((await readConfig()).subagent?.model).toBe("openai/o4-mini");

    engine.send({ type: "set-subagent-model", model: null });
    await engine.whenIdle();
    await settle();
    expect(engine.snapshot().subagentModel).toBeUndefined();
    // A null patch DELETES the key, so subagents inherit the main model again.
    expect((await readConfig()).subagent?.model).toBeUndefined();
  });
});

test("/reasoning persists and surfaces in the snapshot", async () => {
  await withTempHome(async (readConfig) => {
    const engine = makeEngine();
    collect(engine);

    engine.send({ type: "run-slash", name: "reasoning", args: "high" });
    await engine.whenIdle();
    await settle();
    expect(engine.snapshot().reasoning).toBe("high");
    expect((await readConfig()).reasoning?.effort).toBe("high");

    engine.send({ type: "run-slash", name: "reasoning", args: "off" });
    await engine.whenIdle();
    await settle();
    expect(engine.snapshot().reasoning).toBeUndefined();
    expect((await readConfig()).reasoning?.effort).toBeUndefined();
  });
});

test("listModels returns provider models as summaries for the picker", async () => {
  const registry = new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => ({}) as never,
      listModels: async () => [
        { id: "test", providerId: "mock", name: "Test Model", contextWindow: 8000 },
        { id: "big", providerId: "mock", contextWindow: 200000 },
      ],
    },
  ]);
  const engine = makeEngine(registry);
  const models = await engine.listModels();
  // Both models surface, carrying the fields the picker needs (id, providerId).
  expect(models.some((m) => m.providerId === "mock" && m.id === "test")).toBe(true);
  expect(models.some((m) => m.providerId === "mock" && m.id === "big")).toBe(true);
  const test = models.find((m) => m.id === "test");
  expect(test?.contextWindow).toBe(8000);
});

test("/models refresh force-pulls the catalog", async () => {
  const registry = new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => ({}) as never,
      listModels: async () => [],
    },
  ]);
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL) => {
    fetched++;
    return new Response(JSON.stringify({ openai: { models: { "gpt-5.2": {} } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const engine = makeEngine(registry);
    const events = collect(engine);
    engine.send({ type: "run-slash", name: "models", args: "refresh" });
    await engine.whenIdle();
    expect(events.some((e) => e.type === "notice" && /refreshed/i.test(e.message))).toBe(true);
    expect(fetched).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
