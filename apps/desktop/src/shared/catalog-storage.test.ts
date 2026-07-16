import { describe, expect, it } from "vitest";
import { limitCatalogOptions, normalizeStoredModelIds } from "./catalog-draft";

describe("stored model catalog ids", () => {
  it("deduplicates and bounds renderer-persisted catalog state", () => {
    expect(normalizeStoredModelIds(["a", "a", "b", "c"], 2)).toEqual(["a", "b"]);
  });

  it("drops malformed, empty, and pathologically large values", () => {
    expect(normalizeStoredModelIds([null, 1, "", "x".repeat(513), "valid"], 8)).toEqual([
      "valid",
    ]);
    expect(normalizeStoredModelIds({ model: "valid" }, 8)).toEqual([]);
  });
});

describe("catalog render bounds", () => {
  it("limits actionable rows while retaining section labels and current selection", () => {
    const result = limitCatalogOptions([
      { key: "__section__a", primary: "A", secondary: "", section: true },
      { key: "a1", primary: "a1", secondary: "", line: "a1" },
      { key: "a2", primary: "a2", secondary: "", line: "a2" },
      { key: "__section__b", primary: "B", secondary: "", section: true },
      { key: "b1", primary: "b1", secondary: "", line: "b1", current: true },
    ], 1);

    expect(result.options.map((option) => option.key)).toEqual([
      "__section__a",
      "a1",
      "__section__b",
      "b1",
    ]);
    expect(result).toMatchObject({ omitted: 1, totalItems: 3 });
  });

  it("handles a zero or negative limit without dropping a current row", () => {
    const options = [
      { key: "one", primary: "one", secondary: "", line: "one" },
      { key: "two", primary: "two", secondary: "", line: "two", current: true },
    ];
    expect(limitCatalogOptions(options, -1).options.map((option) => option.key)).toEqual(["two"]);
  });
});
