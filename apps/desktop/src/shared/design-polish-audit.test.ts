/**
 * Structural verification of the design polish audit deliverable.
 * Analysis-only goal: document must cover required UI surfaces, cite real
 * renderer paths, preserve design-system character, and not require product
 * code changes to exist.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const AUDIT_PATH = join(process.cwd(), "plans", "DESIGN-POLISH-AUDIT.md");

/** Major surfaces required by the goal acceptance criteria. */
const REQUIRED_SECTION_MARKERS = [
  "# 1. Layout & chrome",
  "# 2. Surfaces, backgrounds, elevation, frost",
  "# 3. Hover, press, active, disabled",
  "# 4. Focus-visible treatment",
  "# 5. Motion, enter/exit, interactive animation",
  "# 6. Appear / disappear of menus, panels, toasts",
  "# 7. Typography hierarchy",
  "# 8. Spacing & alignment",
  "# 9. Responsive & breakpoints",
] as const;

/** Findings must ground in real shipped modules / contracts. */
const REQUIRED_PATH_ANCHORS = [
  "src/renderer/styles.css",
  "src/renderer/layout/ProjectRail.tsx",
  "src/renderer/layout/WorkspaceDock.tsx",
  "src/renderer/composer/Composer.tsx",
  "src/renderer/App.tsx",
  "src/renderer/panels/JobsView.tsx",
  "src/renderer/git/GitPanel.tsx",
  "src/renderer/panels/Inspector.tsx",
  "design-system.md",
  "UI.md",
  "tools/ui-preview/shoot.mjs",
  "tools/ui-preview/mock-vibe.ts",
] as const;

/** Severity vocabulary used by findings. */
const SEVERITY_MARKERS = [
  "**bug-feeling**",
  "**a11y**",
  "**inconsistency**",
  "**polish**",
] as const;

describe("design polish audit deliverable", () => {
  it("exists at plans/DESIGN-POLISH-AUDIT.md", () => {
    expect(existsSync(AUDIT_PATH), `missing ${AUDIT_PATH}`).toBe(true);
  });

  it("covers layout, surfaces, hover/press, focus, motion, appear/disappear, type, spacing, responsive", () => {
    const text = readFileSync(AUDIT_PATH, "utf8");
    for (const marker of REQUIRED_SECTION_MARKERS) {
      expect(text.includes(marker), `missing section: ${marker}`).toBe(true);
    }
    // Explicit design-system preservation (not a redesign brief)
    expect(text.toLowerCase()).toMatch(/preserve|preserving|not a redesign|design system/);
    expect(text).toContain("Documentation only");
  });

  it("cites real in-repo renderer/shared paths and contracts", () => {
    const text = readFileSync(AUDIT_PATH, "utf8");
    for (const path of REQUIRED_PATH_ANCHORS) {
      expect(text.includes(path), `audit must cite ${path}`).toBe(true);
      if (path.startsWith("src/") || path.startsWith("tools/") || path === "design-system.md" || path === "UI.md") {
        expect(existsSync(join(process.cwd(), path)), `broken path anchor ${path}`).toBe(true);
      }
    }
  });

  it("documents a substantial structured finding inventory with severity + direction", () => {
    const text = readFileSync(AUDIT_PATH, "utf8");
    // Numbered findings D-01 … D-NN
    const findingIds = text.match(/^### D-\d+/gm) ?? [];
    expect(findingIds.length).toBeGreaterThanOrEqual(40);

    for (const sev of SEVERITY_MARKERS) {
      expect(text.includes(sev) || text.includes(sev.replace(/\*\*/g, "")), `severity vocab ${sev}`).toBe(
        true,
      );
    }

    // Each finding family should include observable issue + improvement direction
    const directionHits = (text.match(/\*\*Direction:\*\*/g) ?? []).length;
    const issueHits = (text.match(/\*\*Issue:\*\*/g) ?? []).length;
    expect(issueHits).toBeGreaterThanOrEqual(40);
    expect(directionHits).toBeGreaterThanOrEqual(40);
    expect(directionHits).toBe(issueHits);

    // Spot-check: findings name concrete CSS/classes/tokens (not generic advice only)
    const concrete = [
      "--focus-ring",
      "workspace-dock",
      "composer-wrap",
      "prefers-reduced-motion",
      "activity-rail",
      "ProjectRail",
    ];
    for (const token of concrete) {
      expect(text.includes(token), `expected concrete anchor ${token}`).toBe(true);
    }
  });

  it("spot-checks ≥8 findings against real files/classes in the repo", () => {
    const text = readFileSync(AUDIT_PATH, "utf8");
    const styles = readFileSync(join(process.cwd(), "src/renderer/styles.css"), "utf8");
    const rail = readFileSync(join(process.cwd(), "src/renderer/layout/ProjectRail.tsx"), "utf8");
    const dock = readFileSync(join(process.cwd(), "src/renderer/layout/WorkspaceDock.tsx"), "utf8");

    // D-12: undefined onboarding/utility tokens are mapped to the existing scale.
    expect(text).toContain("--leading-copy");
    expect(styles).toContain("var(--leading-prose)");
    expect(styles).not.toContain("var(--leading-copy)");
    expect(styles).not.toMatch(/--leading-copy\s*:/);

    expect(text).toContain("--text-h3");
    expect(styles).toContain("var(--text-heading)");
    expect(styles).not.toContain("var(--text-h3)");
    expect(styles).not.toMatch(/--text-h3\s*:/);

    // D-01 / the rail keeps section-level + actions as its primary grammar.
    expect(text).toMatch(/rail-primary|New chat|Open project/);
    expect(rail).toContain("New chat");
    expect(rail).toContain("Add project");
    expect(rail).not.toContain("rail-primary-actions");

    // Dock contract surface
    expect(text).toContain("workspace-dock");
    expect(dock).toContain('className="workspace-dock"');
    expect(styles).toContain(".workspace-dock");
    expect(styles).toMatch(/\.workspace-dock\s*\{[^}]*top:\s*var\(--space-base\);[^}]*right:\s*var\(--space-base\);[^}]*border:\s*1px solid[^}]*background:\s*var\(--surface-subtle\);[^}]*box-shadow:\s*none;/s);
    expect(styles).not.toContain("--shadow-dock");
    expect(styles).not.toContain("--glass-shell-bg");
    expect(styles).toContain("background: var(--glass-overlay-bg)");
    expect(styles).toContain("backdrop-filter: var(--glass-overlay-filter)");
    expect(styles).toContain("backdrop-filter: var(--glass-float-filter)");
    expect(styles).toMatch(/\.hover-reveal:hover,\s*\.hover-reveal:focus-within\s*\{[^}]*opacity:\s*1;/s);
    expect(styles).toMatch(/@media \(hover: none\)[\s\S]*?\.hover-reveal\s*\{[^}]*opacity:\s*1;/);

    // Focus dual dialect
    expect(text).toContain("0 0 0 3px");
    expect(styles).toContain("0 0 0 3px");
    expect(styles).toContain("--focus-ring:");

    // Layout transition violation callout grounded in CSS
    expect(text.toLowerCase()).toMatch(/width|flex-basis/);
    expect(styles).not.toMatch(/(?:width|flex-basis) var\(--dur-moderate\)/);
    expect(styles).toContain("transform var(--dur-moderate)");
    expect(styles).not.toContain("activity-rail-enter");
    expect(styles).toMatch(/@keyframes activity-panel-enter\s*\{[^}]*opacity:\s*0;[^}]*\}/s);
    expect(styles).toContain("@keyframes activity-drawer-enter");

    // D-09 / D-10: settings navigation densifies before the form can clip.
    expect(styles).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.settings-rail \.settings-nav-desc \{ display: none; \}/);
    expect(styles).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.setting-field\s*\{[\s\S]*?grid-template-columns: 1fr;/);
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.workspace:has\(\.settings-layer\.is-open\)\s*\{[\s\S]*?flex-direction: column;/);

    // Composer frost surface
    expect(text).toContain("composer-wrap");
    expect(styles).toContain(".composer-wrap::before");

    // Reduced motion
    expect(text).toContain("prefers-reduced-motion");
    expect(styles).toContain("prefers-reduced-motion");
  });

  it("does not prescribe redesigning the design system or product character", () => {
    const text = readFileSync(AUDIT_PATH, "utf8");
    expect(text.toLowerCase()).not.toMatch(/replace the design system|new visual language|redesign the product/);
    expect(text).toContain("quiet dense");
    expect(text).toMatch(/Graphite|token-first|theme-faithful/);
  });
});
