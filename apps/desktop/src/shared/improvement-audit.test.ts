/**
 * Structural verification of the improvement audit deliverable.
 * Post-implementation: document must remain multi-layer, prioritize residual
 * honestly (fixed inventory + deferred labels), and cite real repo paths.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const AUDIT_PATH = join(process.cwd(), "plans", "IMPROVEMENT-AUDIT.md");

const REQUIRED_LAYER_MARKERS = [
  "# 1. Main process",
  "# 2. Preload",
  "# 3. Renderer",
  "# 4. Shared pure modules",
  "# 5. Packaging, scripts, CI, tests, docs",
  "# 7. Scope honesty",
] as const;

const REQUIRED_PATH_ANCHORS = [
  "src/main/engine-bridge.ts",
  "src/main/host-resolver.ts",
  "src/main/index.ts",
  "src/main/ipc-security.ts",
  "src/preload/index.ts",
  "src/renderer/hooks/useSession.ts",
  "src/renderer/App.tsx",
  "src/shared/git-ops.ts",
  "src/shared/config-io.ts",
  "src/shared/protocol.ts",
  "src/shared/reducer.ts",
  "test/e2e/harness.spec.ts",
  "AGENTS.md",
  "PARITY.md",
] as const;

describe("improvement audit deliverable", () => {
  it("exists at plans/IMPROVEMENT-AUDIT.md", () => {
    expect(existsSync(AUDIT_PATH), `missing ${AUDIT_PATH}`).toBe(true);
  });

  it("covers every major layer and hard constraints", () => {
    const text = readFileSync(AUDIT_PATH, "utf8");
    for (const marker of REQUIRED_LAYER_MARKERS) {
      expect(text.includes(marker), `missing section marker: ${marker}`).toBe(true);
    }
    expect(text.includes("Hard constraints")).toBe(true);
    expect(text.includes("Intentional non-goals") || text.includes("Intentional non-goals")).toBe(true);
    expect(text.includes("No engine fork")).toBe(true);
    expect(text.includes("Busy until") || text.includes("busy until") || text.includes("Busy until `engine-idle`") || text.includes("engine-idle")).toBe(true);
    // Post-implementation: either open P0/P1 findings OR fixed inventory of them
    expect(
      text.includes("### P0") ||
        text.includes("### P1") ||
        text.includes("Fixed inventory") ||
        text.includes("| P0 "),
    ).toBe(true);
  });

  it("cites real in-repo modules across main/preload/renderer/shared/tests", () => {
    const text = readFileSync(AUDIT_PATH, "utf8");
    for (const path of REQUIRED_PATH_ANCHORS) {
      const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
      const cited = text.includes(path) || (base !== path && text.includes(base));
      expect(cited, `audit must cite ${path} (or basename ${base})`).toBe(true);
      if (path.startsWith("src/") || path.startsWith("test/")) {
        expect(existsSync(join(process.cwd(), path)), `broken path anchor ${path}`).toBe(true);
      }
    }
    expect(text.includes("src/main/")).toBe(true);
    expect(text.includes("src/preload/")).toBe(true);
    expect(text.includes("src/renderer/")).toBe(true);
    expect(text.includes("src/shared/")).toBe(true);
    expect(text.includes("test/e2e/") || text.includes("harness.spec")).toBe(true);
  });

  it("lists a substantial evidence-backed backlog (fixed and/or residual)", () => {
    const text = readFileSync(AUDIT_PATH, "utf8");
    // Count severity markers OR fixed-inventory table rows
    const severityHits = (text.match(/### P[0-3]/g) ?? []).length;
    const tableHits = (text.match(/\| P[0-3] /g) ?? []).length;
    expect(severityHits + tableHits).toBeGreaterThanOrEqual(20);
    expect(text.includes("Industry-leading product direction")).toBe(true);
    expect(text.includes("Engine-adjacent")).toBe(true);
    // Honest deferred labels present after implementation pass
    expect(
      text.includes("Credential-gated") ||
        text.includes("credential-gated") ||
        text.includes("Deferred"),
    ).toBe(true);
  });
});
