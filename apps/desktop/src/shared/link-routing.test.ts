import { describe, expect, it } from "vitest";
import { linkDisposition } from "./link-routing";

describe("linkDisposition", () => {
  it("opens ordinary web content inside Vibe", () => {
    expect(linkDisposition("https://example.com/docs")).toBe("embedded");
    expect(linkDisposition("http://localhost:3000")).toBe("embedded");
  });

  it("keeps modifier clicks and sensitive flows external", () => {
    expect(linkDisposition("https://example.com", { metaKey: true })).toBe("external");
    expect(linkDisposition("https://example.com", { button: 1 })).toBe("external");
    expect(linkDisposition("https://accounts.example.com/login")).toBe("external");
    expect(linkDisposition("https://checkout.stripe.com/pay/test")).toBe("external");
  });

  it("rejects unsafe protocols and embedded credentials", () => {
    expect(linkDisposition("file:///etc/passwd")).toBe("reject");
    expect(linkDisposition("https://user:pass@example.com")).toBe("reject");
  });
});
