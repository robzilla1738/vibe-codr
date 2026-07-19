#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * Copy vibecodr-engine-host into resources/ for packaging.
 * Fails if the binary is older than engine runtime sources (same freshness
 * rule as host-resolver) so packs cannot embed a stale host silently.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "resources");
const binaryName = process.platform === "win32" ? "vibecodr-engine-host.exe" : "vibecodr-engine-host";
const dest = join(destDir, binaryName);
const engineCommit = readFileSync(join(root, "ENGINE_COMMIT"), "utf8").trim();
if (!/^[0-9a-f]{40}$/i.test(engineCommit)) {
  console.error("Refusing to pack: ENGINE_COMMIT must contain a 40-character git commit");
  process.exit(1);
}

const ENGINE_BUILD_INPUT_PATHS = [
  "bun.lock",
  "package.json",
  "tsconfig.base.json",
  "packages/config/package.json",
  "packages/config/tsconfig.json",
  "packages/config/src",
  "packages/core/package.json",
  "packages/core/tsconfig.json",
  "packages/core/src",
  "packages/macos-bridge/package.json",
  "packages/macos-bridge/tsconfig.json",
  "packages/macos-bridge/bin/engine-host.ts",
  "scripts/build-macos-bridge.ts",
  "packages/macos-bridge/src",
  "packages/plugins/package.json",
  "packages/plugins/tsconfig.json",
  "packages/plugins/src",
  "packages/providers/package.json",
  "packages/providers/tsconfig.json",
  "packages/providers/src",
  "packages/shared/package.json",
  "packages/shared/tsconfig.json",
  "packages/shared/src",
  "packages/tools/package.json",
  "packages/tools/tsconfig.json",
  "packages/tools/src",
];

const SOURCE_EXTENSIONS = new Set([".json", ".lock", ".ts", ".tsx"]);

function newestSourceMtime(engineRoot) {
  let newest = 0;
  const visit = (path) => {
    let entry;
    try {
      entry = statSync(path);
    } catch {
      return;
    }
    if (entry.isFile()) {
      if (SOURCE_EXTENSIONS.has(extname(path))) {
        newest = Math.max(newest, entry.mtimeMs);
      }
      return;
    }
    if (!entry.isDirectory()) return;
    let children;
    try {
      children = readdirSync(path);
    } catch {
      return;
    }
    for (const child of children) visit(join(path, child));
  };
  for (const rel of ENGINE_BUILD_INPUT_PATHS) visit(join(engineRoot, rel));
  return newest;
}

function engineRootForBinary(binPath) {
  // …/dist/vibecodr-engine-host → engine root
  return dirname(dirname(binPath));
}

const candidates = [
  process.env.VIBE_CODR_ROOT && join(process.env.VIBE_CODR_ROOT, "dist", binaryName),
  join(root, "..", "..", "dist", binaryName),
  join(root, "..", "cli", "dist", binaryName),
  join(root, "..", "vibe-codr", "dist", binaryName),
  join(homedir(), "Code", "vibe-codr", "dist", binaryName),
  join(homedir(), "code", "vibe-codr", "dist", binaryName),
].filter(Boolean);

const src = candidates.find((p) => p && existsSync(p));
if (!src) {
  console.error(
    "vibecodr-engine-host not found. Build the monorepo engine host or set VIBE_CODR_ROOT.",
  );
  process.exit(1);
}

const engineRoot = engineRootForBinary(src);
try {
  const checkoutCommit = execFileSync(
    "git",
    ["-C", engineRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  if (checkoutCommit !== engineCommit) {
    console.error(
      `Refusing to pack engine ${checkoutCommit}; Vibe Codr desktop locks ${engineCommit}.\n` +
        `Check out ENGINE_COMMIT in ${engineRoot}, rebuild the host, and retry.`,
    );
    process.exit(1);
  }
  const dirtyRuntime = execFileSync(
    "git",
    [
      "-C",
      engineRoot,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ...ENGINE_BUILD_INPUT_PATHS,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  ).trim();
  if (dirtyRuntime) {
    console.error(
      `Refusing to pack a runtime-dirty engine checkout at ${engineRoot}:\n${dirtyRuntime}\n` +
        "Commit the engine changes, update ENGINE_COMMIT, and rebuild the host.",
    );
    process.exit(1);
  }
} catch (error) {
  if (typeof error === "object" && error !== null && "status" in error && error.status === 1) {
    process.exit(1);
  }
  console.error(
    `Refusing to pack: could not verify locked engine checkout at ${engineRoot}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
const binaryMtime = statSync(src).mtimeMs;
const sourceMtime = newestSourceMtime(engineRoot);
if (sourceMtime > binaryMtime) {
  console.error(
    `Refusing to pack a stale host: sources under ${engineRoot} are newer than ${src}.\n` +
      `Run: cd ${engineRoot} && bun run build:macos-bridge`,
  );
  process.exit(1);
}

// Refuse clearly non-executable or zero-length binaries; on macOS prefer matching arch when file(1) is available.
const st = statSync(src);
if (st.size < 1024) {
  console.error(`Refusing to pack host binary that is too small (${st.size} bytes): ${src}`);
  process.exit(1);
}
if (process.platform === "darwin") {
  try {
    const fileOut = execFileSync("file", ["-b", src], { encoding: "utf8" });
    const want = process.arch === "arm64" ? "arm64" : "x86_64";
    if (!fileOut.includes(want) && !fileOut.includes("universal")) {
      console.error(
        `Refusing to pack host for arch ${process.arch}: file reports "${fileOut.trim()}"\n` +
          `Rebuild the host on this machine: cd ${engineRoot} && bun run build:macos-bridge`,
      );
      process.exit(1);
    }
  } catch {
    /* file(1) unavailable — size/freshness checks still apply */
  }
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
if (process.platform !== "win32") chmodSync(dest, 0o755);
console.log(`Copied ${src} → ${dest} (fresh vs sources @ ${engineRoot})`);
