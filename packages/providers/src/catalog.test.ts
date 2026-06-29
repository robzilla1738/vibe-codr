import { test, expect } from "bun:test";
import { parseModelsDev } from "./catalog.ts";

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
