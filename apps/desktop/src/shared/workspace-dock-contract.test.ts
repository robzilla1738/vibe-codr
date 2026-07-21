import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedFilesTotals } from "./changed-files";

/**
 * Design-direction contract for the workspace dock: quiet flat list of
 * Session / Changes / Git / Terminal / Jobs / Files — no Local+Files duplicate, no
 * commit/compare chrome that belongs in the Git end panel.
 */
describe("workspace dock design contract", () => {
  const source = readFileSync(
    join(process.cwd(), "src/renderer/layout/WorkspaceDock.tsx"),
    "utf8",
  );
  const appSource = readFileSync(join(process.cwd(), "src/renderer/App.tsx"), "utf8");
  const sidebarSource = readFileSync(
    join(process.cwd(), "src/renderer/layout/ActivitySidebar.tsx"),
    "utf8",
  );
  const headerSource = readFileSync(
    join(process.cwd(), "src/renderer/layout/ActivityPanelHeader.tsx"),
    "utf8",
  );
  const inspectorSource = readFileSync(join(process.cwd(), "src/renderer/panels/Inspector.tsx"), "utf8");
  const changesSource = readFileSync(join(process.cwd(), "src/renderer/panels/ChangesView.tsx"), "utf8");
  const jobsSource = readFileSync(join(process.cwd(), "src/renderer/panels/JobsView.tsx"), "utf8");
  const gitSource = readFileSync(join(process.cwd(), "src/renderer/git/GitPanel.tsx"), "utf8");
  const terminalSource = readFileSync(
    join(process.cwd(), "src/renderer/panels/TerminalPanel.tsx"),
    "utf8",
  );
  const styles = readFileSync(join(process.cwd(), "src/renderer/styles.css"), "utf8");

  it("exposes only Session, Changes, Git, Terminal, Jobs, Files rows", () => {
    const labels = [...source.matchAll(/label="([^"]+)"/g)].map((m) => m[1]);
    // Branch label is dynamic template — still one Git row.
    const staticLabels = labels.filter((l) => !l.includes("${") && l !== "Git");
    // Template string for Git · branch counts as the Git row via aria.
    expect(source).toContain('ariaLabel="Show session panel"');
    expect(source).toContain('ariaLabel="Show session changes"');
    expect(source).toContain('ariaLabel="Open git panel"');
    expect(source).toContain('ariaLabel="Open project terminal"');
    expect(source).toContain('ariaLabel="Toggle background jobs"');
    expect(source).toContain('ariaLabel="Reveal project in Finder"');

    expect(source).not.toContain("Commit or push");
    expect(source).not.toContain("Compare branch");
    expect(source).not.toContain('label="Local"');
    // Exactly one Files / Finder row (aria + title may both mention reveal)
    expect((source.match(/ariaLabel="Reveal project in Finder"/g) ?? []).length).toBe(1);
    expect((source.match(/onOpen\("files"\)/g) ?? []).length).toBe(1);
    for (const target of ["session", "changes", "git", "terminal", "jobs", "files"]) {
      expect((source.match(new RegExp(`onOpen\\("${target}"\\)`, "g")) ?? []).length).toBe(1);
    }
    // No section divider chrome
    expect(source).not.toContain("workspace-dock-divider");
    expect(source).not.toContain("workspace-dock-section-label");
    expect(source).toContain("data-empty-home={emptyHome || undefined}");
    expect(appSource).toContain("emptyHome={");
    void staticLabels;
  });

  it("uses changedFilesTotals for change meta (shipped pure helper)", () => {
    const totals = changedFilesTotals([
      { path: "a.ts", added: 2, removed: 1 },
      { path: "b.ts", added: 0, removed: 3 },
    ]);
    expect(totals).toEqual({ count: 2, added: 2, removed: 4 });
  });

  it("opens every tool in one structural edge-attached activity sidebar", () => {
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr) min(var(--activity-rail-w), 48%)");
    expect(styles).toMatch(/\.activity-sidebar\s*\{[\s\S]*?position: relative;/);
    expect(styles).toMatch(/\.activity-sidebar\s*\{[\s\S]*?border-left:/);
    expect(styles).toMatch(/\.activity-sidebar\s*\{[\s\S]*?border-radius: 0;/);
    expect(styles).toMatch(/\.activity-sidebar\s*\{[\s\S]*?box-shadow: none;/);
    expect(appSource).toContain('"Resize activity sidebar"');
    expect(appSource).toContain('"Resize changes sidebar"');
    expect(appSource).not.toContain("jobs-drawer-root");
    expect(appSource).not.toContain("jobs-drawer-backdrop");
    expect(appSource).not.toContain("jobs-drawer");
    expect(appSource).toContain('className="activity-rail jobs-activity-rail"');
    expect(gitSource).not.toContain("git-drawer");
    expect(gitSource).not.toContain("export function GitContent");
    expect(gitSource).toContain('className="activity-rail git-activity-rail"');
    for (const label of ["Session", "Changes", "Git", "Terminal", "Jobs"]) {
      expect(sidebarSource).toContain(`label: "${label}"`);
    }
    expect(terminalSource).toContain('getPropertyValue("--font-sans")');
    expect(terminalSource).toContain("fontFamily: terminalFontFromTokens()");
    expect(terminalSource).toContain("new WebLinksAddon");
    expect(terminalSource).toContain("window.vibe.openExternal(uri)");
    expect(terminalSource).toContain("letterSpacing: 0");
  });

  it("uses equal switcher columns and one shared header across every view", () => {
    expect(styles).toMatch(/\.activity-sidebar-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\);/);
    expect(headerSource).toContain('className="activity-panel-header sidebar-heading-row"');
    for (const panel of [inspectorSource, changesSource, gitSource, terminalSource, jobsSource]) {
      expect(panel).toContain("ActivityPanelHeader");
    }
    expect(styles).not.toMatch(/\.activity-sidebar-tabs\s*\{[^}]*border-bottom:/s);
    expect(styles).not.toMatch(/\.sidebar-heading-row\s*\{[^}]*border-bottom:/s);
    expect(styles).toMatch(/\.sidebar-heading-row\s*\{[^}]*font-family:\s*var\(--font-sans\);/s);
    expect(styles).toMatch(/\.sidebar-heading-row \.sidebar-heading-title\s*\{[^}]*font-size:\s*var\(--text-label\);/s);
  });

  it("keeps diff color roles separate from generic error semantics", () => {
    expect(styles).toContain("--diff-add: #00d26a");
    expect(styles).toContain("--diff-del: #ff4d4f");
    expect(styles).toContain(".diff-add-count { color: var(--diff-add); }");
    expect(styles).toContain(".diff-del-count { color: var(--diff-del); }");
    expect(styles).toContain(".terminal-panel-error { color: var(--del); }");
  });

  it("renders Changes as a nested tree and numbered File mode", () => {
    expect(changesSource).toContain('role="tree"');
    expect(changesSource).toContain('role="treeitem"');
    expect(changesSource).toContain("buildChangedFileTree");
    expect(changesSource).toContain("file-preview-line-number");
    expect(changesSource).toContain("NumberedFilePreview");
  });

  it("keeps the reserved dock lane on the same continuous chat-stage veil", () => {
    expect(styles).toMatch(
      /\.content-inset:has\(> \.workspace-dock\) \.chat-column:not\(\.is-empty\)::after\s*\{[\s\S]*?inset-inline-end:\s*calc\(-1 \* \(var\(--workspace-dock-w\) \+ var\(--space-lg\)\)\);/,
    );
  });

  it("keeps compact dock and drawer controls outside Electron drag regions", () => {
    expect(styles).toMatch(/\.workspace-dock\s*\{[\s\S]*?-webkit-app-region:\s*no-drag;[\s\S]*?pointer-events:\s*auto;/);
    expect(styles).toMatch(/\.workspace-dock-row\s*\{[\s\S]*?-webkit-app-region:\s*no-drag;[\s\S]*?touch-action:\s*manipulation;/);
    expect(styles).toMatch(/@media \(max-width: 960px\)[\s\S]*?grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\);/);
    expect(styles).toMatch(/@media \(max-width: 960px\)[\s\S]*?\.workspace-dock-row\s*\{[\s\S]*?min-height:\s*44px;/);
    expect(styles).toMatch(
      /@media \(max-width: 960px\)[\s\S]*?\.workspace-dock\[data-empty-home="true"\]\s*\{[\s\S]*?width:\s*min\(184px,[\s\S]*?\.workspace-dock\[data-empty-home="true"\] \.workspace-dock-row\s*\{[\s\S]*?min-height:\s*24px;/,
    );
    expect(styles).toMatch(
      /\.workspace-dock\[data-empty-home="true"\] \.workspace-dock-row-icon svg\s*\{[\s\S]*?width:\s*11px;[\s\S]*?height:\s*11px;/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.topbar-meta\s*\{\s*display:\s*none;\s*\}/,
    );
    expect(styles).toMatch(/\.activity-sidebar\s*\{[\s\S]*?-webkit-app-region:\s*no-drag;/);
  });
});
