import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural contract for two-step N deny:
 * - After open, focus stays on Deny button (not the reason input) so second N works.
 * - Deny button handles N when denyOpen to confirm without App routing through free-text.
 * - Deny reason field uses Enter to confirm (N types "n" when user is composing a reason).
 */
describe("permission deny N two-step contract", () => {
  const livePanels = readFileSync(
    join(process.cwd(), "src/renderer/panels/LivePanels.tsx"),
    "utf8",
  );
  const app = readFileSync(join(process.cwd(), "src/renderer/App.tsx"), "utf8");

  it("keeps focus on Deny button after open, not the reason input", () => {
    expect(livePanels).toContain("denyBtnRef.current?.focus");
    // Must NOT auto-focus the free-text field on open (that stole second N).
    const openEffect = livePanels.slice(
      livePanels.indexOf("After opening deny"),
      livePanels.indexOf("const confirmDeny"),
    );
    expect(openEffect).toContain("denyBtnRef");
    expect(openEffect).not.toContain("denyInputRef.current?.focus");
  });

  it("Deny button confirms with N when deny is open", () => {
    expect(livePanels).toMatch(/denyOpen && \(event\.key === "n"/);
    expect(livePanels).toContain("confirmDeny()");
  });

  it("App does not treat deny-reason free-text as a global N chord", () => {
    expect(app).toContain("inPermDenyReason");
    expect(app).toContain("!inPermDenyReason");
    expect(app).toContain("setPermDenyKick");
  });

  it("describes persistent grants as exact-request scope", () => {
    expect(livePanels).toContain("Allow this exact request for the rest of this session");
    expect(livePanels).toContain("Allow this exact request for this project and future sessions");
  });
});
