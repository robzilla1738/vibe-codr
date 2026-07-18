import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// Lazy electron access so this module is importable outside the Electron runtime
// (the relay server reuses the same host resolution without a live `app`).
const electronApp = (): { isPackaged: boolean; getAppPath(): string } | null => {
  try {
    return createRequire(import.meta.url)("electron").app as { isPackaged: boolean; getAppPath(): string };
  } catch {
    return null;
  }
};

export interface HostLaunch {
  executable: string;
  arguments: string[];
  workingDirectory: string;
  description: string;
}

/** Injectable filesystem / app seams for pure unit tests. */
export interface HostResolverDeps {
  existsSync: (path: string) => boolean;
  statSync: (path: string) => { mtimeMs: number; isFile(): boolean; isDirectory(): boolean };
  readdirSync: (path: string) => string[];
  homedir: () => string;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  resourcesPath: string | null;
  appPath: string;
  /** Runtime platform; injectable so packaged Windows resolution is testable. */
  platform?: NodeJS.Platform;
  /** Override wall clock for mtime cache TTL tests. */
  now?: () => number;
}

const DEFAULT_DEPS = (): HostResolverDeps => ({
  existsSync,
  statSync: (path) => {
    const s = statSync(path);
    return {
      mtimeMs: s.mtimeMs,
      isFile: () => s.isFile(),
      isDirectory: () => s.isDirectory(),
    };
  },
  readdirSync: (path) => readdirSync(path),
  homedir,
  env: process.env,
  isPackaged: (() => { const a = electronApp(); return a ? a.isPackaged : false; })(),
  resourcesPath: (() => {
    try {
      return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? null;
    } catch {
      return null;
    }
  })(),
  appPath: (() => {
    try {
      const a = electronApp();
      return a ? a.getAppPath() : process.cwd();
    } catch {
      return process.cwd();
    }
  })(),
  platform: process.platform,
  now: () => Date.now(),
});

function hostBinaryName(deps: Pick<HostResolverDeps, "platform">): string {
  return (deps.platform ?? process.platform) === "win32"
    ? "vibecodr-engine-host.exe"
    : "vibecodr-engine-host";
}

function conventionalRoots(home: string): string[] {
  return [
    join(home, "Code", "vibe-codr"),
    join(home, "code", "vibe-codr"),
    join(home, "Developer", "vibe-codr"),
    join(home, "src", "vibe-codr"),
  ];
}

// A compiled host is only safe to use while it still represents the checked
// out engine. Keep this list focused on runtime source so a stale binary
// cannot hide newer fixes in the sibling repository during development.
const ENGINE_SOURCE_PATHS = [
  "packages/config/src",
  "packages/core/src",
  "packages/macos-bridge/src",
  "packages/macos-bridge/bin/engine-host.ts",
  "packages/plugins/src",
  "packages/providers/src",
  "packages/shared/src",
  "packages/tools/src",
];

const SOURCE_EXTENSIONS = new Set([".json", ".ts", ".tsx"]);

/** Cache newest source mtime per root for a short TTL (avoids multi-second
 * main-thread walks on every bootstrap during project switches). */
const MTIME_CACHE_TTL_MS = 5_000;
const mtimeCache = new Map<string, { value: number; at: number }>();

/** Test / hot-reload seam: clear the source-mtime cache. */
export function clearHostResolverMtimeCache(): void {
  mtimeCache.clear();
}

export function newestSourceMtime(root: string, deps: HostResolverDeps = DEFAULT_DEPS()): number {
  const now = (deps.now ?? Date.now)();
  const cached = mtimeCache.get(root);
  if (cached && now - cached.at < MTIME_CACHE_TTL_MS) return cached.value;

  let newest = 0;

  const visit = (path: string): void => {
    let entry: ReturnType<HostResolverDeps["statSync"]>;
    try {
      entry = deps.statSync(path);
    } catch {
      return;
    }

    if (entry.isFile()) {
      const dot = path.lastIndexOf(".");
      if (dot >= 0 && SOURCE_EXTENSIONS.has(path.slice(dot))) {
        newest = Math.max(newest, entry.mtimeMs);
      }
      return;
    }
    if (!entry.isDirectory()) return;

    let children: string[];
    try {
      children = deps.readdirSync(path);
    } catch {
      return;
    }
    for (const child of children) visit(join(path, child));
  };

  for (const relativePath of ENGINE_SOURCE_PATHS) {
    visit(join(root, relativePath));
  }
  mtimeCache.set(root, { value: newest, at: now });
  return newest;
}

function whichBun(deps: HostResolverDeps): string | null {
  const home = deps.homedir();
  const windows = (deps.platform ?? process.platform) === "win32";
  const executable = windows ? "bun.exe" : "bun";
  const candidates = [join(home, ".bun", "bin", executable)];
  if (!windows) candidates.push("/opt/homebrew/bin/bun", "/usr/local/bin/bun");
  // Also honor PATH entries (GUI apps often still have a usable PATH in tests).
  const pathDirs = (deps.env.PATH ?? "").split(windows ? ";" : ":").filter(Boolean);
  for (const dir of pathDirs) {
    candidates.push(join(dir, executable));
  }
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (deps.existsSync(c)) return c;
  }
  return null;
}

function tryCompiledHost(root: string, deps: HostResolverDeps): HostLaunch | null {
  const bin = join(root, "dist", hostBinaryName(deps));
  if (!deps.existsSync(bin)) return null;
  try {
    const binaryMtime = deps.statSync(bin).mtimeMs;
    const sourceMtime = newestSourceMtime(root, deps);
    if (sourceMtime > binaryMtime) return null;
  } catch {
    return null;
  }
  return {
    executable: bin,
    arguments: [],
    workingDirectory: root,
    description: `compiled ${bin}`,
  };
}

function trySourceHost(root: string, deps: HostResolverDeps): HostLaunch | null {
  const entry = join(root, "packages", "macos-bridge", "bin", "engine-host.ts");
  if (!deps.existsSync(entry)) return null;
  const bun = whichBun(deps);
  if (!bun) return null;
  return {
    executable: bun,
    arguments: ["run", entry],
    workingDirectory: root,
    description: `bun ${entry}`,
  };
}

function tryRoot(root: string, deps: HostResolverDeps): HostLaunch | null {
  return tryCompiledHost(root, deps) ?? trySourceHost(root, deps);
}

function bundledHost(deps: HostResolverDeps): HostLaunch | null {
  const binaryName = hostBinaryName(deps);
  if (deps.resourcesPath) {
    const bin = join(deps.resourcesPath, binaryName);
    if (deps.existsSync(bin)) {
      return {
        executable: bin,
        arguments: [],
        workingDirectory: deps.homedir(),
        description: `bundled ${bin}`,
      };
    }
  }
  // Dev: resources/ next to project root
  const devBin = join(deps.appPath, "resources", binaryName);
  if (deps.existsSync(devBin)) {
    return {
      executable: devBin,
      arguments: [],
      workingDirectory: deps.appPath,
      description: `dev resources ${devBin}`,
    };
  }
  return null;
}

/**
 * Resolve vibecodr-engine-host the same way as the macOS Swift shell.
 * Pass `deps` only from tests — production uses live Electron/fs.
 */
export function resolveHostLaunch(deps: HostResolverDeps = DEFAULT_DEPS()): HostLaunch {
  const envRoot = deps.env.VIBE_CODR_ROOT;
  if (envRoot) {
    const hit = tryRoot(envRoot, deps);
    if (hit) return hit;
    // Explicit override that fails must not silently fall through — that
    // produced "wrong engine" debugging nightmares.
    throw new Error(
      `VIBE_CODR_ROOT=${envRoot} does not contain a usable vibecodr-engine-host (compiled dist or Bun source). Build with \`bun run build:macos-bridge\` or install Bun.`,
    );
  }
  // A packaged app must prefer the host shipped with that exact release. A
  // developer may also have ~/Code/vibe-codr, but it can be older/newer and
  // protocol-incompatible. VIBE_CODR_ROOT remains the explicit override.
  if (deps.isPackaged) {
    const bundled = bundledHost(deps);
    if (bundled) return bundled;
  }
  // In the canonical monorepo the desktop app lives at apps/desktop and the
  // engine packages live at the repository root. Keep this ahead of legacy
  // home-directory conventions so development always runs the checked-out
  // engine that belongs to this exact desktop source.
  const monorepoRoot = join(deps.appPath, "..", "..");
  const monorepoHost = tryRoot(monorepoRoot, deps);
  if (monorepoHost) return monorepoHost;
  for (const root of conventionalRoots(deps.homedir())) {
    const hit = tryRoot(root, deps);
    if (hit) return hit;
  }
  const bundled = bundledHost(deps);
  if (bundled) return bundled;
  throw new Error(
    "Could not find vibecodr-engine-host. Clone vibe-codr to ~/Code/vibe-codr, set VIBE_CODR_ROOT, run `bun run build:macos-bridge`, or install Bun.",
  );
}

/** PATH enrichment so GUI-launched hosts find bun/git/node. */
export function enrichedEnv(
  deps?: Pick<HostResolverDeps, "homedir" | "env" | "platform">,
): NodeJS.ProcessEnv {
  const home = (deps?.homedir ?? homedir)();
  const env = deps?.env ?? process.env;
  const windows = (deps?.platform ?? process.platform) === "win32";
  const separator = windows ? ";" : ":";
  const extraEntries = windows
    ? [join(home, ".bun", "bin")]
    : [join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const extras = extraEntries.join(separator);
  const path = env.PATH ? `${extras}${separator}${env.PATH}` : extras;
  return {
    ...env,
    HOME: env.HOME ?? home,
    PATH: path,
  };
}
