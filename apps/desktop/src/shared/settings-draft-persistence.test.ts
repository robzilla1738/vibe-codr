import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("settings draft persistence contract", () => {
  const panel = readFileSync(
    join(process.cwd(), "src/renderer/settings/SettingsPanel.tsx"),
    "utf8",
  );
  const controls = readFileSync(
    join(process.cwd(), "src/renderer/settings/FormControls.tsx"),
    "utf8",
  );
  const mcp = readFileSync(
    join(process.cwd(), "src/renderer/settings/sections/McpSection.tsx"),
    "utf8",
  );
  const providers = readFileSync(
    join(process.cwd(), "src/renderer/settings/sections/ProvidersSection.tsx"),
    "utf8",
  );
  const models = readFileSync(
    join(process.cwd(), "src/renderer/settings/sections/ModelsSection.tsx"),
    "utf8",
  );
  const advanced = readFileSync(
    join(process.cwd(), "src/renderer/settings/sections/AdvancedSection.tsx"),
    "utf8",
  );
  const settingsModels = readFileSync(
    join(process.cwd(), "src/renderer/settings/sections/ModelsSection.tsx"),
    "utf8",
  );

  it("keeps config sections mounted across navigation", () => {
    expect(panel).toContain('SETTINGS_SECTIONS.filter(({ id }) => id !== "instructions").map');
    expect(panel).toContain("hidden={activeSection !== id}");
  });

  it("includes malformed key/value drafts in the dirty and save guards", () => {
    expect(controls).toContain("onInvalidDraftChange?.(resetKey, true)");
    expect(panel).toContain("invalidDraftsRef.current.size > 0");
    expect(panel).toContain("state.saving || invalidDrafts.size > 0");
  });

  it("keeps provider and MCP field editors mounted while cards collapse", () => {
    expect(mcp).toContain("hidden={!isExpanded}");
    expect(providers).toContain("hidden={!isExpanded}");
  });

  it("guards every unfinished add-row draft and clears it on reset/context change", () => {
    for (const section of [providers, mcp, models, advanced]) {
      expect(section).toContain("onInvalidDraftChange?.(");
      expect(section).toContain("draftResetVersion");
    }
    expect(models).toContain("[draftKey, draftResetVersion]");
    expect(advanced).toContain("[scope, cwd, draftResetVersion]");
    expect(panel).toContain("Finish or clear draft fields before saving");
  });

  it("keeps everyday setup short while preserving searchable advanced controls", () => {
    expect(panel).toContain("Advanced settings");
    expect(panel).toContain("advancedVisible");
    expect(providers).toContain('className="provider-advanced"');
    expect(providers).toContain("providerChoiceDefaultBaseURL");
    expect(settingsModels).toContain('className="settings-advanced-panel"');
  });
});
