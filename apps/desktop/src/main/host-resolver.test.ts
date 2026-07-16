import { describe, expect, it, beforeEach } from "vitest";
import {
  clearHostResolverMtimeCache,
  newestSourceMtime,
  resolveHostLaunch,
  type HostResolverDeps,
} from "./host-resolver";

function makeFs(files: Record<string, { mtimeMs?: number; dir?: boolean; children?: string[] }>) {
  return {
    existsSync: (path: string) => path in files,
    statSync: (path: string) => {
      const f = files[path];
      if (!f) throw new Error(`ENOENT ${path}`);
      return {
        mtimeMs: f.mtimeMs ?? 1,
        isFile: () => !f.dir,
        isDirectory: () => !!f.dir,
      };
    },
    readdirSync: (path: string) => {
      const f = files[path];
      if (!f?.dir) throw new Error(`ENOTDIR ${path}`);
      return f.children ?? [];
    },
  };
}

function baseDeps(overrides: Partial<HostResolverDeps> & { files?: Record<string, { mtimeMs?: number; dir?: boolean; children?: string[] }> }): HostResolverDeps {
  const files = overrides.files ?? {};
  const fs = makeFs(files);
  return {
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    readdirSync: fs.readdirSync,
    homedir: () => "/home/dev",
    env: {},
    isPackaged: false,
    resourcesPath: null,
    appPath: "/app",
    platform: "linux",
    now: () => 1_000_000,
    ...overrides,
    // keep files helper out of the deps object
    ...(overrides.files ? {} : {}),
  };
}

beforeEach(() => {
  clearHostResolverMtimeCache();
});

describe("resolveHostLaunch", () => {
  it("rejects a compiled host when engine sources are newer", () => {
    const root = "/home/dev/Code/vibe-codr";
    const deps = baseDeps({
      env: { VIBE_CODR_ROOT: root },
      files: {
        [`${root}/dist/vibecodr-engine-host`]: { mtimeMs: 100 },
        [`${root}/packages/core/src`]: { dir: true, children: ["index.ts"] },
        [`${root}/packages/core/src/index.ts`]: { mtimeMs: 200 },
        // other ENGINE_SOURCE_PATHS missing → skipped
      },
    });
    // With only core/src newer, compiled is rejected; no bun/source → throw
    expect(() => resolveHostLaunch(deps)).toThrow(/does not contain a usable/);
  });

  it("uses compiled host when it is fresher than sources", () => {
    const root = "/home/dev/Code/vibe-codr";
    const deps = baseDeps({
      env: { VIBE_CODR_ROOT: root },
      files: {
        [`${root}/dist/vibecodr-engine-host`]: { mtimeMs: 500 },
        [`${root}/packages/core/src`]: { dir: true, children: ["index.ts"] },
        [`${root}/packages/core/src/index.ts`]: { mtimeMs: 100 },
      },
    });
    const launch = resolveHostLaunch(deps);
    expect(launch.executable).toBe(`${root}/dist/vibecodr-engine-host`);
    expect(launch.description).toContain("compiled");
  });

  it("falls back to Bun source when compiled is stale", () => {
    const root = "/home/dev/Code/vibe-codr";
    const entry = `${root}/packages/macos-bridge/bin/engine-host.ts`;
    const deps = baseDeps({
      env: { VIBE_CODR_ROOT: root },
      files: {
        [`${root}/dist/vibecodr-engine-host`]: { mtimeMs: 100 },
        [`${root}/packages/core/src`]: { dir: true, children: ["index.ts"] },
        [`${root}/packages/core/src/index.ts`]: { mtimeMs: 200 },
        [entry]: { mtimeMs: 200 },
        "/home/dev/.bun/bin/bun": { mtimeMs: 1 },
      },
    });
    const launch = resolveHostLaunch(deps);
    expect(launch.executable).toBe("/home/dev/.bun/bin/bun");
    expect(launch.arguments).toEqual(["run", entry]);
  });

  it("packaged apps prefer the bundled host over a sibling checkout", () => {
    const deps = baseDeps({
      isPackaged: true,
      resourcesPath: "/App/Contents/Resources",
      files: {
        "/App/Contents/Resources/vibecodr-engine-host": { mtimeMs: 1 },
        // Sibling would resolve if we looked — must not win when packaged
        "/home/dev/Code/vibe-codr/dist/vibecodr-engine-host": { mtimeMs: 999 },
      },
    });
    const launch = resolveHostLaunch(deps);
    expect(launch.description).toContain("bundled");
    expect(launch.executable).toBe("/App/Contents/Resources/vibecodr-engine-host");
  });

  it("uses the engine at the canonical monorepo root during development", () => {
    const root = "/repo";
    const deps = baseDeps({
      appPath: "/repo/apps/desktop",
      files: {
        [`${root}/dist/vibecodr-engine-host`]: { mtimeMs: 500 },
        [`${root}/packages/core/src`]: { dir: true, children: ["index.ts"] },
        [`${root}/packages/core/src/index.ts`]: { mtimeMs: 100 },
      },
    });
    expect(resolveHostLaunch(deps).executable).toBe(`${root}/dist/vibecodr-engine-host`);
  });

  it("uses the .exe host bundled in a packaged Windows app", () => {
    const deps = baseDeps({
      isPackaged: true,
      platform: "win32",
      resourcesPath: "/resources",
      files: {
        "/resources/vibecodr-engine-host.exe": { mtimeMs: 1 },
      },
    });
    const launch = resolveHostLaunch(deps);
    expect(launch.executable).toBe("/resources/vibecodr-engine-host.exe");
    expect(launch.description).toContain("bundled");
  });

  it("throws clearly when VIBE_CODR_ROOT is set but unusable", () => {
    const deps = baseDeps({
      env: { VIBE_CODR_ROOT: "/missing/vibe-codr" },
      files: {},
    });
    expect(() => resolveHostLaunch(deps)).toThrow(/VIBE_CODR_ROOT=/);
  });
});

describe("newestSourceMtime cache", () => {
  it("reuses the cached value within the TTL", () => {
    const root = "/repo";
    let reads = 0;
    let now = 1_000;
    const files: Record<string, { mtimeMs?: number; dir?: boolean; children?: string[] }> = {
      [`${root}/packages/core/src`]: { dir: true, children: ["a.ts"] },
      [`${root}/packages/core/src/a.ts`]: { mtimeMs: 42 },
    };
    const deps = baseDeps({
      files,
      now: () => now,
      readdirSync: (path) => {
        reads += 1;
        return makeFs(files).readdirSync(path);
      },
      statSync: (path) => {
        reads += 1;
        return makeFs(files).statSync(path);
      },
      existsSync: (path) => path in files,
    });
    expect(newestSourceMtime(root, deps)).toBe(42);
    const afterFirst = reads;
    expect(newestSourceMtime(root, deps)).toBe(42);
    expect(reads).toBe(afterFirst); // cache hit
    now += 10_000; // past TTL
    expect(newestSourceMtime(root, deps)).toBe(42);
    expect(reads).toBeGreaterThan(afterFirst);
  });
});
