import { describe, expect, it } from "vitest";
import { estimateJsonUtf8Bytes } from "./json-size";

describe("estimateJsonUtf8Bytes", () => {
  it("matches JSON UTF-8 size for strings, escapes, and emoji", () => {
    const value = { text: "line\nquoted \"value\" 😄", list: [true, null, 42] };
    expect(estimateJsonUtf8Bytes(value, 10_000)).toBe(
      Buffer.byteLength(JSON.stringify(value), "utf8"),
    );
  });

  it("stops at the byte ceiling and rejects cyclic data", () => {
    expect(estimateJsonUtf8Bytes({ text: "x".repeat(100) }, 20)).toBe(21);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(estimateJsonUtf8Bytes(cyclic, 100)).toBe(101);
  });
});
