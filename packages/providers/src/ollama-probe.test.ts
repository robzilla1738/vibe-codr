import { test, expect } from "bun:test";
import { extractContextLength } from "./ollama-probe.ts";

test("extractContextLength reads model_info context_length", () => {
  expect(
    extractContextLength({
      model_info: { "glm.context_length": 131072, "glm.embedding_length": 4096 },
    }),
  ).toBe(131072);
});

test("extractContextLength falls back to num_ctx in parameters", () => {
  expect(extractContextLength({ parameters: "stop foo\nnum_ctx 8192\n" })).toBe(8192);
});

test("extractContextLength returns undefined when nothing usable", () => {
  expect(extractContextLength({})).toBeUndefined();
  expect(extractContextLength({ model_info: { "glm.context_length": 0 } })).toBeUndefined();
});

test("extractContextLength prefers the served num_ctx over the architectural max", () => {
  // A 128k-capable model served with an 8k window must report 8k, not 128k, so
  // the UI/compaction don't believe in headroom a request would 400 on.
  expect(
    extractContextLength({
      model_info: { "qwen3.context_length": 131072 },
      parameters: "stop <|im_end|>\nnum_ctx 8192\n",
    }),
  ).toBe(8192);
  // If num_ctx is somehow larger than the architectural cap, clamp to the cap.
  expect(
    extractContextLength({
      model_info: { "qwen3.context_length": 32768 },
      parameters: "num_ctx 131072\n",
    }),
  ).toBe(32768);
});
