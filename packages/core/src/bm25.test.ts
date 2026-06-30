import { test, expect } from "bun:test";
import { rankBm25, reciprocalRankFusion, queryTerms } from "./bm25.ts";

test("queryTerms drops stopwords unless that empties the query", () => {
  expect(queryTerms("the config loader")).toEqual(["config", "loader"]);
  expect(queryTerms("the and of")).toEqual(["the", "and", "of"]); // all stopwords → kept
});

test("rankBm25 ranks the most relevant doc first and ignores non-matches", () => {
  const texts = [
    "the config loader parses JSONC files",
    "authentication via OAuth redirect",
    "loader utilities for the build",
  ];
  const hits = rankBm25("config loader", texts);
  expect(hits[0]!.index).toBe(0); // the only doc with both terms
  expect(hits.every((h) => h.score > 0)).toBe(true);
  expect(hits.find((h) => h.index === 1)).toBeUndefined(); // no shared terms
});

test("rankBm25 does whole-word matching ('the' is not inside 'other')", () => {
  const hits = rankBm25("the", ["the cat", "mother brother"]);
  expect(hits).toHaveLength(1);
  expect(hits[0]!.index).toBe(0);
});

test("reciprocalRankFusion boosts an id present in multiple lists", () => {
  // 'b' appears in BOTH rankings; 'a' and 'c' each appear in one.
  const fused = reciprocalRankFusion([
    ["a", "b"],
    ["b", "c"],
  ]);
  expect(fused[0]!.id).toBe("b"); // consensus across both lists wins
  expect(new Set(fused.map((f) => f.id))).toEqual(new Set(["a", "b", "c"]));
});

test("reciprocalRankFusion handles a single ranking", () => {
  const fused = reciprocalRankFusion([["x", "y", "z"]]);
  expect(fused.map((f) => f.id)).toEqual(["x", "y", "z"]);
});
