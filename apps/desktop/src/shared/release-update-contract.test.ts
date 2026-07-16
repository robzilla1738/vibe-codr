import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageBuild {
  mac?: { target?: string[] };
  win?: { target?: Array<{ target: string; arch: string[] }> };
  publish?: Array<{ provider: string; owner: string; repo: string }>;
}

describe("direct release and update contract", () => {
  const root = process.cwd();
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    build?: PackageBuild;
  };
  const updaterSource = readFileSync(join(root, "src/main/app-updater.ts"), "utf8");
  const mainSource = readFileSync(join(root, "src/main/index.ts"), "utf8");
  const releaseWorkflow = readFileSync(join(root, "..", "..", ".github/workflows/release.yml"), "utf8");

  it("builds the updater-supported macOS and Windows targets", () => {
    expect(packageJson.dependencies?.["electron-updater"]).toBeDefined();
    expect(packageJson.build?.mac?.target).toEqual(["dmg", "zip"]);
    expect(packageJson.build?.win?.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(packageJson.scripts?.["dist:win"]).toContain("--win nsis --x64");
    expect(packageJson.scripts?.["dist:win:store"]).toBeUndefined();
  });

  it("publishes installers, differential metadata, and both update feeds", () => {
    expect(packageJson.build?.publish).toEqual([
      { provider: "github", owner: "robzilla1738", repo: "vibe-codr", releaseType: "release" },
    ]);
    expect(releaseWorkflow).toContain("release/latest-mac.yml");
    expect(releaseWorkflow).toContain("release/latest.yml");
    expect(releaseWorkflow).toContain("release/*.blockmap");
    expect(releaseWorkflow).toContain("release/*.exe");
    expect(releaseWorkflow).not.toContain("appxupload");
  });

  it("requires consent and completes owned-process cleanup before install", () => {
    expect(updaterSource).toContain("updater.autoDownload = false");
    expect(updaterSource).toContain("updater.autoInstallOnAppQuit = false");
    expect(updaterSource).toContain('buttons: ["Download Update", "Later"]');
    expect(updaterSource).toContain('buttons: ["Restart and Install", "Later"]');
    expect(updaterSource.indexOf("await options.prepareToInstall()")).toBeLessThan(
      updaterSource.indexOf("updater.quitAndInstall"),
    );
    expect(mainSource.indexOf("await cleanupForQuit()", mainSource.indexOf("prepareToInstallUpdate"))).toBeLessThan(
      mainSource.indexOf("allowUpdaterQuit = true"),
    );
  });
});
