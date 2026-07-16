import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";
import { resolveAppPath, resolveOpenTuiPreload } from "./tui.ts";

describe("standalone TUI resolution", () => {
  it("uses the stable companion filename beside a compiled executable", () => {
    const root = mkdtempSync(join(tmpdir(), "vibe-standalone-"));
    const executable = join(root, "vibecodr");
    const app = join(root, "vibecodr-app.js");
    writeFileSync(app, "export const mountApp = () => {};");
    expect(resolveAppPath({ moduleDir: join(root, "missing"), execPath: executable })).toBe(app);
  });

  it("loads the archive-local OpenTUI preload before package resolution", () => {
    const root = mkdtempSync(join(tmpdir(), "vibe-preload-"));
    const preload = join(root, "node_modules", "@opentui", "solid", "scripts", "preload.js");
    mkdirSync(join(preload, ".."), { recursive: true });
    writeFileSync(preload, "export {};");
    expect(resolveOpenTuiPreload(join(root, "vibecodr-app.js"))).toBe(pathToFileURL(preload).href);
  });
});
