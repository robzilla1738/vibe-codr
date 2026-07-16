import { describe, expect, it } from "vitest";
import { safeExternalUrl } from "./external-url";

describe("safeExternalUrl", () => {
  it("normalizes HTTP(S) destinations", () => {
    expect(safeExternalUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(safeExternalUrl("http://localhost:3000")).toBe("http://localhost:3000/");
  });

  it("rejects non-web, malformed, and credential-bearing URLs", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
    expect(safeExternalUrl("https://trusted.example@evil.example/path")).toBeNull();
    expect(safeExternalUrl("https://user:secret@example.com/path")).toBeNull();
  });
});
