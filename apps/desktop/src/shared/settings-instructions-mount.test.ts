import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Production guard: Instructions (VIBE.md) drafts must not unmount on section
 * switch. SettingsFormArea keeps the section mounted and hidden so dirty bind
 * + editor content survive Models ↔ Instructions navigation.
 */
describe("settings instructions mount contract", () => {
  const panelSrc = readFileSync(
    resolve(import.meta.dirname, "../renderer/settings/SettingsPanel.tsx"),
    "utf8",
  );
  const instructionsSrc = readFileSync(
    resolve(import.meta.dirname, "../renderer/settings/sections/InstructionsSection.tsx"),
    "utf8",
  );
  const advancedSrc = readFileSync(
    resolve(import.meta.dirname, "../renderer/settings/sections/AdvancedSection.tsx"),
    "utf8",
  );
  const appSrc = readFileSync(resolve(import.meta.dirname, "../renderer/App.tsx"), "utf8");

  it("keeps InstructionsSection mounted while hidden on other sections", () => {
    expect(panelSrc).toMatch(/hidden=\{activeSection !== "instructions"\}/);
    expect(panelSrc).toMatch(/<InstructionsSection/);
    // Config sections use the same mounted/hidden pattern rather than an
    // exclusive render branch that would unmount local drafts.
    expect(panelSrc).toContain('SETTINGS_SECTIONS.filter(({ id }) => id !== "instructions").map');
    expect(panelSrc).toContain("hidden={activeSection !== id}");
  });

  it("does not clear the dirty binder on InstructionsSection unmount", () => {
    // The old bug bound `() => false` on cleanup, wiping shell dirty when
    // switching away from Instructions.
    expect(instructionsSrc).not.toMatch(/onBindDirty\?\.\(\(\) => false\)/);
    expect(instructionsSrc).toMatch(/onBindDirty\?\.\(\(\) => dirtyRef\.current\)/);
  });

  it("keeps edits made during an async save dirty", () => {
    expect(panelSrc).toContain("const savedConfig = state.config");
    expect(panelSrc).toContain("original: savedConfig");
    expect(panelSrc).toContain("dirty: !configEqual(savedConfig, prev.config)");
    expect(panelSrc).not.toContain("original: prev.config, dirty: false");
    expect(instructionsSrc).toContain("const savedContent = content");
    expect(instructionsSrc).toContain("setOriginal(savedContent)");
    expect(instructionsSrc).toContain("contentRef.current === savedContent");
  });

  it("invalidates stale save results after a settings context change", () => {
    expect(panelSrc).toContain("if (seq !== loadSeq.current) return");
    expect(instructionsSrc).toContain("if (seq !== loadSeq.current) return");
  });

  it("keeps hidden Settings mounted without letting it consume Escape", () => {
    expect(panelSrc).toMatch(/function SettingsFormArea\(\{\s*active,/);
    expect(panelSrc).toMatch(/useEffect\(\(\) => \{\s*if \(!active\) return;\s*const onKeyDown/);
    expect(panelSrc).toContain("active={active}");
  });

  it("refreshes diagnostics and plugin health for the visible foreground runtime", () => {
    expect(panelSrc).toContain('active={active && activeSection === "advanced"}');
    expect(panelSrc).toContain("runtimeIdentity={runtimeIdentity}");
    expect(appSrc).toMatch(/runtimeIdentity=\{`\$\{cwd \?\? ""\}\\0\$\{chrome\.sessionId\}`\}/);
    expect(advancedSrc).toMatch(/if \(!active\) return;/);
    expect(advancedSrc.match(/\[active, cwd, runtimeIdentity\]/g)).toHaveLength(2);
    expect(advancedSrc).toContain("getPerformanceSummary({ days: 1 })");
    expect(advancedSrc).toContain("getPerformanceSummary({ days: 7 })");
    expect(advancedSrc).toContain("PERFORMANCE_PHASES.map");
  });
});
