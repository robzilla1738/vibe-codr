import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("activity sidebar keyboard ownership", () => {
  const sidebar = readFileSync(
    join(process.cwd(), "src/renderer/layout/ActivitySidebar.tsx"),
    "utf8",
  );
  const app = readFileSync(join(process.cwd(), "src/renderer/App.tsx"), "utf8");

  it("lets nested controls consume Escape before the sidebar closes", () => {
    expect(sidebar).toContain('event.key !== "Escape" || event.defaultPrevented');
    expect(sidebar).toContain("if (inTextEntry) return");
    expect(sidebar).toContain('window.addEventListener("keydown", closeOnEscape);');
    expect(sidebar).not.toContain(
      'window.addEventListener("keydown", closeOnEscape, { capture: true })',
    );
  });

  it("does not route Escape from non-composer inputs into global panel dismissal", () => {
    expect(app).toContain("if (inInput && !inComposer) return;");
    expect(app).not.toContain("inInput && !inComposer && !inEndPanel");
  });
});
