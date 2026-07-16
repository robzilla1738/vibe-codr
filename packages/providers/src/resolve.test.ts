import { test, expect } from "bun:test";
import { parseModelString, formatModelString } from "./resolve.ts";
import { ModelResolutionError } from "@vibe/shared";

test("splits on the first slash", () => {
  expect(parseModelString("anthropic/claude-opus-4-8")).toEqual({
    providerId: "anthropic",
    modelId: "claude-opus-4-8",
  });
});

test("keeps internal slashes for aggregators", () => {
  expect(parseModelString("openrouter/anthropic/claude-opus-4-8")).toEqual({
    providerId: "openrouter",
    modelId: "anthropic/claude-opus-4-8",
  });
});

test("handles local model ids", () => {
  expect(parseModelString("lmstudio/qwen2.5-coder-32b")).toEqual({
    providerId: "lmstudio",
    modelId: "qwen2.5-coder-32b",
  });
});

test("round-trips", () => {
  const ref = parseModelString("openai/gpt-x");
  expect(formatModelString(ref)).toBe("openai/gpt-x");
});

test("rejects malformed strings", () => {
  expect(() => parseModelString("nope")).toThrow(ModelResolutionError);
  expect(() => parseModelString("/leading")).toThrow(ModelResolutionError);
  expect(() => parseModelString("trailing/")).toThrow(ModelResolutionError);
});
