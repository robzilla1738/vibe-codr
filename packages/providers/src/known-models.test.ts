import { test, expect } from "bun:test";
import { CatalogService } from "./catalog.ts";
import { knownModelDefaults, knownModelInfo, KNOWN_MODEL_DEFAULTS } from "./known-models.ts";

test("known defaults pin Muse Spark 1.1 context, price, and vision", () => {
  const k = knownModelDefaults("meta/muse-spark-1.1");
  expect(k).toBeDefined();
  expect(k!.contextWindow).toBe(1_048_576);
  expect(k!.pricing.input).toBe(1.25);
  expect(k!.pricing.output).toBe(4.25);
  expect(k!.pricing.cacheRead).toBe(0.15);
  expect(k!.vision).toBe(true);
  expect(knownModelInfo("meta/muse-spark-1.1")?.capabilities?.reasoning).toBe(true);
  expect(KNOWN_MODEL_DEFAULTS["meta/muse-spark-1.1"]).toBe(k);
});

test("CatalogService falls back to known-model defaults when models.dev has no entry", async () => {
  // Cold catalog (metadata not loaded): pricing/context/vision still return
  // published Meta rates instead of undefined / 128k / $0.
  const cold = new CatalogService();
  const price = await cold.pricing("meta/muse-spark-1.1");
  expect(price?.input).toBe(1.25);
  expect(price?.output).toBe(4.25);
  expect(price?.cacheRead).toBe(0.15);

  const window = await cold.contextWindow("meta/muse-spark-1.1");
  expect(window).toBe(1_048_576);

  const vision = await cold.supportsImages("meta/muse-spark-1.1");
  expect(vision).toBe(true);
});

test("unknown models have no known defaults", () => {
  expect(knownModelDefaults("openai/gpt-4o")).toBeUndefined();
  expect(knownModelInfo("totally/fake")).toBeUndefined();
});
