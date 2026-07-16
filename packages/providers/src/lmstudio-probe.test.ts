import { test, expect } from "bun:test";
import { extractLmStudioContext } from "./lmstudio-probe.ts";

const models = [
  { id: "qwen2.5-coder-7b", loaded_context_length: 8192, max_context_length: 32768 },
  { id: "llama-3.1-8b", max_context_length: 131072 },
  { id: "phi-4", loaded_context_length: 16384 },
];

test("extractLmStudioContext prefers the SERVED (loaded) window over the max", () => {
  // A 32k-capable model loaded at 8k must report 8k — the UI/compaction must not
  // believe in headroom a request would 400 on.
  expect(extractLmStudioContext(models, "qwen2.5-coder-7b")).toBe(8192);
});

test("extractLmStudioContext falls back to max when no loaded length is present", () => {
  expect(extractLmStudioContext(models, "llama-3.1-8b")).toBe(131072);
  expect(extractLmStudioContext(models, "phi-4")).toBe(16384);
});

test("extractLmStudioContext returns undefined for an unlisted model", () => {
  expect(extractLmStudioContext(models, "not-loaded")).toBeUndefined();
  expect(extractLmStudioContext([], "anything")).toBeUndefined();
});

test("extractLmStudioContext ignores non-positive lengths", () => {
  expect(
    extractLmStudioContext([{ id: "x", loaded_context_length: 0, max_context_length: 0 }], "x"),
  ).toBeUndefined();
  // A zero loaded length falls through to the positive max.
  expect(
    extractLmStudioContext([{ id: "y", loaded_context_length: 0, max_context_length: 4096 }], "y"),
  ).toBe(4096);
});
