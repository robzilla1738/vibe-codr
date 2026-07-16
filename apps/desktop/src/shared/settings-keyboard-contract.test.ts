import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("settings keyboard ownership contract", () => {
  const panel = readFileSync(
    join(process.cwd(), "src/renderer/settings/SettingsPanel.tsx"),
    "utf8",
  );
  const app = readFileSync(join(process.cwd(), "src/renderer/App.tsx"), "utf8");
  const draftOwners = [
    "ModelsSection.tsx",
    "AdvancedSection.tsx",
    "McpSection.tsx",
    "ProvidersSection.tsx",
  ].map((file) =>
    readFileSync(join(process.cwd(), "src/renderer/settings/sections", file), "utf8"),
  );

  it("lets child controls consume Escape before Settings closes", () => {
    expect(panel).toContain('event.key === "Escape" && !event.defaultPrevented');
    expect(panel).toContain('document.addEventListener("keydown", onKeyDown);');
    expect(panel).not.toContain('document.addEventListener("keydown", onKeyDown, true)');
    for (const source of draftOwners) {
      expect(source).toContain("preventDefault()");
      expect(source).toContain("stopPropagation()");
    }
  });

  it("does not route chat shortcuts behind Settings, Sessions, or text editors", () => {
    expect(app).toContain("const chatShortcutAvailable = !settingsOpen && !sessionsOpen && (!inInput || inComposer)");
    for (const key of ['e.key === "t"', 'e.key === "d"', 'e.key === "o"', 'e.key === "k"']) {
      expect(app).toContain(`chatShortcutAvailable && ${key}`);
    }
    expect(app).toContain("target.isContentEditable");
  });
});
