import { describe, expect, it } from "vitest";
import { applyConfigPatch, buildConfigPatch } from "./config-diff";

describe("buildConfigPatch", () => {
  it("returns an empty patch when nothing changed", () => {
    const cfg = { model: "openai/gpt-5.5", mode: "plan" };
    expect(buildConfigPatch(cfg, cfg)).toEqual({});
  });

  it("sets a changed primitive", () => {
    expect(buildConfigPatch({ model: "a" }, { model: "b" })).toEqual({ model: "b" });
  });

  it("deletes a key cleared to undefined", () => {
    const original = { model: "a", planModel: "b" };
    const current = { model: "a", planModel: undefined };
    expect(buildConfigPatch(original, current)).toEqual({ planModel: null });
  });

  it("deletes a key removed from the object", () => {
    const original = { model: "a", planModel: "b" };
    const current = { model: "a" };
    expect(buildConfigPatch(original, current)).toEqual({ planModel: null });
  });

  it("sets a newly-added key", () => {
    expect(buildConfigPatch({ model: "a" }, { model: "a", planModel: "b" })).toEqual({
      planModel: "b",
    });
  });

  it("deep-diffs nested objects and only includes changed sub-keys", () => {
    const original = { subagent: { maxDepth: 3, maxParallel: 8 } };
    const current = { subagent: { maxDepth: 5, maxParallel: 8 } };
    expect(buildConfigPatch(original, current)).toEqual({ subagent: { maxDepth: 5 } });
  });

  it("deletes a nested sub-key cleared to undefined", () => {
    const original = { providers: { openai: { apiKey: "sk-1", baseURL: "u" } } };
    const current = { providers: { openai: { apiKey: undefined, baseURL: "u" } } };
    expect(buildConfigPatch(original, current)).toEqual({
      providers: { openai: { apiKey: null } },
    });
  });

  it("replaces arrays by value, not element-wise", () => {
    const original = { modelFallbacks: ["a", "b"] };
    const current = { modelFallbacks: ["c"] };
    expect(buildConfigPatch(original, current)).toEqual({ modelFallbacks: ["c"] });
  });

  it("omits unchanged arrays", () => {
    const original = { modelFallbacks: ["a", "b"] };
    const current = { modelFallbacks: ["a", "b"] };
    expect(buildConfigPatch(original, current)).toEqual({});
  });

  it("preserves unknown keys that are unchanged", () => {
    const original = { model: "a", unknownKey: 42 };
    const current = { model: "a", unknownKey: 42 };
    expect(buildConfigPatch(original, current)).toEqual({});
  });

  it("handles a type mismatch by replacing the value", () => {
    const original = { details: "normal" };
    const current = { details: { nested: true } };
    expect(buildConfigPatch(original, current)).toEqual({ details: { nested: true } });
  });

  it("handles null-to-value transition", () => {
    const original = { accentColor: undefined };
    const current = { accentColor: "#8b5cf6" };
    expect(buildConfigPatch(original, current)).toEqual({ accentColor: "#8b5cf6" });
  });

  it("handles value-to-null (treated as cleared → delete)", () => {
    const original = { accentColor: "#8b5cf6" };
    const current = { accentColor: null };
    expect(buildConfigPatch(original, current)).toEqual({ accentColor: null });
  });

  it("deep-diffs a newly-added nested object", () => {
    const original = { model: "a" };
    const current = { model: "a", subagent: { maxDepth: 3 } };
    expect(buildConfigPatch(original, current)).toEqual({ subagent: { maxDepth: 3 } });
  });

  it("ignores newly-created objects whose leaves were cleared back to undefined", () => {
    expect(
      buildConfigPatch({}, { budget: { limitUSD: undefined } }),
    ).toEqual({});
  });

  it("prunes cleared leaves while retaining defined values in a new object", () => {
    expect(
      buildConfigPatch(
        {},
        { budget: { limitUSD: undefined, onExceed: "stop" } },
      ),
    ).toEqual({ budget: { onExceed: "stop" } });
  });

  it("preserves explicitly added empty provider and OAuth objects", () => {
    expect(buildConfigPatch({}, { providers: { custom: {} }, mcp: { oauth: {} } })).toEqual({
      providers: { custom: {} },
      mcp: { oauth: {} },
    });
  });
});

describe("applyConfigPatch", () => {
  it("deep-merges values and deletes null leaves", () => {
    expect(applyConfigPatch(
      { model: "old", providers: { openai: { apiKey: "old", baseURL: "url" } } },
      { model: "new", providers: { openai: { apiKey: null } } },
    )).toEqual({ model: "new", providers: { openai: { baseURL: "url" } } });
  });

  it("produces a reversible onboarding transaction patch", () => {
    const original = { model: "old", providers: { old: { apiKey: "secret" } } };
    const applied = applyConfigPatch(original, {
      model: "new",
      providers: { custom: { baseURL: "https://example.com" } },
    });
    const rollback = buildConfigPatch(applied, original);
    expect(applyConfigPatch(applied, rollback)).toEqual(original);
  });

  it("ignores prototype-polluting patch keys", () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as Record<string, unknown>;
    expect(applyConfigPatch({}, patch)).toEqual({ safe: 1 });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
