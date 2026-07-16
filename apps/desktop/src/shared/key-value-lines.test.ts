import { describe, expect, it } from "vitest";
import { formatKeyValueLines, parseKeyValueLines } from "./key-value-lines";

describe("key-value line editors", () => {
  it("preserves delimiters inside values", () => {
    expect(parseKeyValueLines("TOKEN=a=b\nEMPTY=", "=")).toEqual({
      ok: true,
      value: { TOKEN: "a=b", EMPTY: "" },
    });
    expect(parseKeyValueLines("Authorization: Bearer a:b", ":", { trimValues: true })).toEqual({
      ok: true,
      value: { Authorization: "Bearer a:b" },
    });
  });

  it("keeps incomplete and duplicate lines invalid instead of silently dropping them", () => {
    expect(parseKeyValueLines("TOKEN", "=")).toMatchObject({ ok: false });
    expect(parseKeyValueLines("A=1\nA=2", "=")).toMatchObject({ ok: false });
  });

  it("rejects prototype-mutating record keys", () => {
    expect(parseKeyValueLines("__proto__=polluted", "=")).toMatchObject({ ok: false });
    expect(parseKeyValueLines("constructor: value", ":")).toMatchObject({ ok: false });
  });

  it("formats headers with readable spacing", () => {
    expect(formatKeyValueLines({ Authorization: "Bearer token" }, ":"))
      .toBe("Authorization: Bearer token");
  });
});
