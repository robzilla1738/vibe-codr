import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural contract: density toast only after successful send on BOTH
 * keyboard (⌘D) and composer chip paths — never fire-and-forget toast.
 */
describe("density toast after successful send", () => {
  const app = readFileSync(join(process.cwd(), "src/renderer/App.tsx"), "utf8");

  it("⌘D path awaits send before toast", () => {
    const block = app.slice(
      app.indexOf('e.key === "d" && (e.ctrlKey || e.metaKey)'),
      app.indexOf("Ctrl/Cmd+O fold all"),
    );
    expect(block).toContain("await session.send");
    expect(block).toMatch(/if \(sent\) session\.showToast/);
  });

  it("composer onCycleDensity awaits send before toast", () => {
    const block = app.slice(app.indexOf("onCycleDensity={() =>"), app.indexOf("onPasteError"));
    expect(block).toContain("await session.send");
    expect(block).toMatch(/if \(sent\) session\.showToast/);
    // Must not show toast unconditionally after void send
    expect(block).not.toMatch(/void session\.send[\s\S]*showToast/);
  });
});
