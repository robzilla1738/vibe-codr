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
