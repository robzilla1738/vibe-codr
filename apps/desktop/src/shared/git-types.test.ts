import { describe, expect, it } from "vitest";
import { parseGhPrList, validateGhPrCreateRequest } from "./git-types";

describe("parseGhPrList", () => {
  it("normalizes valid gh output", () => {
    expect(parseGhPrList([{
      number: 42,
      title: "Ship it",
      state: "OPEN",
      headRefName: "feature",
      url: "https://github.com/acme/repo/pull/42",
    }])).toEqual([{
      number: 42,
      title: "Ship it",
      state: "OPEN",
      head: "feature",
      url: "https://github.com/acme/repo/pull/42",
    }]);
  });

  it("rejects malformed entries before they reach the renderer", () => {
    expect(parseGhPrList({})).toBeNull();
    expect(parseGhPrList([{ number: 1, title: "x", state: null, headRefName: "x", url: "https://example.com" }])).toBeNull();
    expect(parseGhPrList([{ number: 1, title: "x", state: "OPEN", headRefName: "x", url: "javascript:alert(1)" }])).toBeNull();
    expect(parseGhPrList([{ number: 1, title: "x", state: "OPEN", headRefName: "x", url: "https://github.com@evil.example/pr/1" }])).toBeNull();
  });
});

describe("validateGhPrCreateRequest", () => {
  it("accepts a bounded normal request", () => {
    expect(validateGhPrCreateRequest({
      cwd: "/repo",
      title: "Ship it",
      body: "Summary\n\n- tested",
      base: "main",
      draft: true,
    })).toBe(true);
  });

  it("rejects empty, oversized, control-bearing, and ill-typed fields", () => {
    expect(validateGhPrCreateRequest({ cwd: "/repo", title: " " })).toBe(false);
    expect(validateGhPrCreateRequest({ cwd: "/repo", title: "x".repeat(1_025) })).toBe(false);
    expect(validateGhPrCreateRequest({ cwd: "/repo", title: "ok", body: "x".repeat(65_537) })).toBe(false);
    expect(validateGhPrCreateRequest({ cwd: "/repo", title: "ok", base: "main\n--web" })).toBe(false);
    expect(validateGhPrCreateRequest({ cwd: "/repo", title: "ok", draft: "yes" })).toBe(false);
  });
});
