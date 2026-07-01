import { test, expect } from "bun:test";
import { defaultConfig } from "@vibe/config";
import {
  buildModelTuning,
  reasoningSupported,
  cacheTokensDisjointFromInput,
} from "./model-tuning.ts";

function cfg(overrides: Record<string, unknown> = {}) {
  return { ...defaultConfig(), ...overrides } as ReturnType<typeof defaultConfig>;
}

test("Anthropic caching is on by default; system is delivered cached", () => {
  const t = buildModelTuning("anthropic/claude-opus-4-8", cfg());
  expect(t.cacheSystem).toBe(true);
});

test("caching can be disabled", () => {
  const t = buildModelTuning("anthropic/claude-opus-4-8", cfg({ caching: { enabled: false } }));
  expect(t.cacheSystem).toBe(false);
});

test("non-Anthropic providers don't get the cache marker", () => {
  expect(buildModelTuning("openai/gpt-x", cfg()).cacheSystem).toBe(false);
});

test("cacheTokensDisjointFromInput is true only for Anthropic", () => {
  expect(cacheTokensDisjointFromInput("anthropic/claude-opus-4-8")).toBe(true);
  expect(cacheTokensDisjointFromInput("openai/gpt-x")).toBe(false);
  expect(cacheTokensDisjointFromInput("openrouter/anthropic/claude")).toBe(false);
  expect(cacheTokensDisjointFromInput("ollama/llama3")).toBe(false);
  expect(cacheTokensDisjointFromInput("garbage")).toBe(false);
});

test("Anthropic thinking budget maps to providerOptions.anthropic.thinking", () => {
  const t = buildModelTuning(
    "anthropic/claude-opus-4-8",
    cfg({ reasoning: { budgetTokens: 4096 } }),
  );
  expect(t.providerOptions?.anthropic).toEqual({
    thinking: { type: "enabled", budgetTokens: 4096 },
  });
});

test("OpenAI effort maps to reasoningEffort", () => {
  const t = buildModelTuning("openai/gpt-x", cfg({ reasoning: { effort: "high" } }));
  expect(t.providerOptions?.openai).toEqual({ reasoningEffort: "high" });
});

test("OpenRouter routes via openai-compatible, so it forwards no native reasoning block", () => {
  // openrouter is driven through @ai-sdk/openai-compatible (it doesn't accept the
  // native unified reasoning options); the model reasons at its default effort.
  const t = buildModelTuning(
    "openrouter/anthropic/claude",
    cfg({ reasoning: { effort: "low", budgetTokens: 1000 } }),
  );
  expect(t.providerOptions?.openrouter).toBeUndefined();
});

test("no reasoning config yields no providerOptions", () => {
  expect(buildModelTuning("openai/gpt-x", cfg()).providerOptions).toBeUndefined();
});

test("Anthropic effort tier derives a thinking budget", () => {
  const t = buildModelTuning("anthropic/claude-opus-4-8", cfg({ reasoning: { effort: "medium" } }));
  expect(t.providerOptions?.anthropic).toEqual({
    thinking: { type: "enabled", budgetTokens: 8192 },
  });
});

test("xAI/Grok routes via openai-compatible, so no native reasoningEffort is forwarded", () => {
  // grok reasons natively; xai is driven through openai-compatible which doesn't
  // take the reasoningEffort option, so we don't emit it.
  const t = buildModelTuning("xai/grok-4", cfg({ reasoning: { effort: "low" } }));
  expect(t.providerOptions?.xai).toBeUndefined();
});

test("reasoningSupported is true for reasoning providers, false for local models", () => {
  expect(reasoningSupported("anthropic/claude-opus-4-8")).toBe(true);
  expect(reasoningSupported("xai/grok-4")).toBe(true);
  expect(reasoningSupported("ollama/llama3.1")).toBe(false);
  expect(reasoningSupported("lmstudio/qwen")).toBe(false);
});
