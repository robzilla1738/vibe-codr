import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("native menu shortcut contract", () => {
  const source = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
  const settingsSource = readFileSync(
    join(process.cwd(), "src/renderer/settings/SettingsPanel.tsx"),
    "utf8",
  );
  const appSource = readFileSync(join(process.cwd(), "src/renderer/App.tsx"), "utf8");

  it("does not steal the transcript Cmd/Ctrl+O fold shortcut", () => {
    const openProject = source.match(
      /label: "Open Project…",([\s\S]*?)click: \(\) => sendMenuAction\("openProject"\)/,
    )?.[1];
    expect(openProject).toBeDefined();
    expect(openProject).not.toContain('accelerator: "CmdOrCtrl+O"');
  });

  it("keeps DevTools distinct from the Session Inspector shortcut", () => {
    expect(source).toContain('role: "toggleDevTools" as const');
    expect(source).toContain('accelerator: "CmdOrCtrl+Alt+I"');
    expect(source).toContain('label: "Toggle Inspector"');
    expect(source).toContain('accelerator: "CmdOrCtrl+Shift+I"');
  });

  it("guards native close and quit when Settings has unsaved state", () => {
    expect(source).toContain('ipcMain.on("settings:dirty"');
    expect(source).toContain('mainWindow.on("close"');
    expect(source).toContain("if (!confirmDiscardSettings(mainWindow))");
    expect(source.indexOf("if (!confirmDiscardSettings(mainWindow))")).toBeLessThan(
      source.indexOf("quitting = true", source.indexOf('app.on("before-quit"')),
    );
    expect(settingsSource).toContain("window.vibe.setSettingsDirty(combinedDirty)");
    expect(settingsSource).toContain("window.vibe.setSettingsDirty(false)");
  });

  it("keeps the native update action discoverable", () => {
    expect(source).toContain('label: "Check for Updates…"');
    expect(source).toContain("appUpdater?.check(true)");
  });

  it("exposes the bounded local runtime capacity in the native Tools menu", () => {
    expect(source).toContain('label: "Local Runtime Capacity"');
    expect(source).toContain("Array.from({ length: 8 }");
    expect(source).toContain("runtimeSettingsStore.update({ capacity })");
    expect(source).toContain("bridge.setLocalRuntimeCapacity(value.capacity)");
  });

  it("guards Continue Latest before replacing a session with dirty Settings", () => {
    const continueLatest = appSource.match(
      /const continueLatest = useCallback\(async \(\) => \{([\s\S]*?)\n {2}\}, \[/,
    )?.[1];
    expect(continueLatest).toBeDefined();
    expect(continueLatest).toContain("const wasDirty = settingsDirtyRef.current()");
    expect(continueLatest).toContain("if (!confirmLeaveSettings()) return");
    expect(continueLatest).toContain("if (wasDirty) setSettingsOpen(false)");
    expect(continueLatest?.indexOf("confirmLeaveSettings")).toBeLessThan(
      continueLatest?.indexOf("session.bootstrap") ?? -1,
    );
  });

  it("keeps panel toggle state updaters pure", () => {
    expect(appSource).not.toContain("setSettingsOpen((prev) =>");
    expect(appSource).not.toContain("setGitOpen((prev) =>");
  });
});
