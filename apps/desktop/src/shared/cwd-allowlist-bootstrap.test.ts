import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Structural contracts for the renderer → engine filesystem capability gate. */
describe("engine cwd authorization", () => {
  const source = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");

  it("rejects unauthorized cwd before starting the host", () => {
    const start = source.indexOf('ipcMain.handle(\n    "engine:bootstrap"');
    const end = source.indexOf('ipcMain.handle("engine:send"', start);
    const block = source.slice(start, end > start ? end : undefined);
    const gateAt = block.indexOf("!isAllowedCwd(message.cwd)");
    const startAt = block.indexOf("await bridge.start");
    expect(gateAt, "allowlist gate missing").toBeGreaterThanOrEqual(0);
    expect(startAt, "bridge.start missing").toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(startAt);
  });

  it("authorizes only validated recent-project results", () => {
    const helperStart = source.indexOf("function authorizeProjectIndex");
    const helperEnd = source.indexOf("function listProjectFilesCached", helperStart);
    const block = source.slice(helperStart, helperEnd > helperStart ? helperEnd : undefined);
    expect(block).toContain("isProjectSummaryArray");
    expect(block).toContain("isAbsolute(project.cwd)");
    expect(block).toContain("statSync(project.cwd).isDirectory()");
    expect(block).toContain("projectCwdAllowlist.add(project.cwd)");
  });

  it("gates project-index mutations by cwd", () => {
    const start = source.indexOf('ipcMain.handle("engine:rpc"');
    const end = source.indexOf('ipcMain.handle("engine:stop"', start);
    const block = source.slice(start, end > start ? end : undefined);
    expect(block).toContain("PROJECT_INDEX_MUTATIONS.has(message.method)");
    expect(block).toContain('typeof cwd !== "string" || !isAllowedProjectRoot(cwd)');
  });
});
