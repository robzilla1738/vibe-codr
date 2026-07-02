import { test, expect } from "bun:test";
import { defaultConfig } from "@vibe/config";
import {
  buildModelTuning,
  reasoningSupported,
  reasoningCategory,
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

test("reasoningCategory splits forwarded, native, and none per provider", () => {
  // Forwarded: the effort hint is actually sent (buildModelTuning emits options).
  expect(reasoningCategory("anthropic/claude-opus-4-8")).toBe("forwarded");
  expect(reasoningCategory("openai/gpt-5.5")).toBe("forwarded");
  // Native: reasons on its own, but the transport drops the hint — no affirmation.
  expect(reasoningCategory("xai/grok-4")).toBe("native");
  expect(reasoningCategory("openrouter/anthropic/claude")).toBe("native");
  expect(reasoningCategory("codex/gpt-5.2-codex")).toBe("native");
  expect(reasoningCategory("deepseek/deepseek-reasoner")).toBe("native");
  // None: local / non-reasoning models ignore it outright.
  expect(reasoningCategory("ollama/llama3.1")).toBe("none");
  expect(reasoningCategory("lmstudio/qwen")).toBe("none");
  expect(reasoningCategory("garbage")).toBe("none");
});

test("only forwarded providers emit reasoning providerOptions (native ones stay bare)", () => {
  // The category split must line up with what buildModelTuning actually forwards:
  // native providers reason but get no options block, so /reasoning can't claim it.
  const c = cfg({ reasoning: { effort: "high" } });
  expect(reasoningCategory("xai/grok-4")).toBe("native");
  expect(buildModelTuning("xai/grok-4", c).providerOptions).toBeUndefined();
  expect(reasoningCategory("openrouter/x")).toBe("native");
  expect(buildModelTuning("openrouter/x", c).providerOptions).toBeUndefined();
});

test("cache breakpoints: tools + conversation markers are Anthropic-only and config-gated", () => {
  const config = defaultConfig();
  const anthropic = buildModelTuning("anthropic/claude-opus-4-8", config);
  expect(anthropic.cacheSystem).toBe(true);
  expect(anthropic.cacheTools).toBe(true);
  expect(anthropic.cacheConversation).toBe(true);

  const openai = buildModelTuning("openai/gpt-5", config);
  expect(openai.cacheTools).toBe(false);
  expect(openai.cacheConversation).toBe(false);

  config.caching.cacheTools = false;
  config.caching.cacheConversation = false;
  const gated = buildModelTuning("anthropic/claude-opus-4-8", config);
  expect(gated.cacheSystem).toBe(true); // master switch untouched
  expect(gated.cacheTools).toBe(false);
  expect(gated.cacheConversation).toBe(false);
});
