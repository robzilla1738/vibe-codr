#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = readFileSync(join(root, "ENGINE_COMMIT"), "utf8").trim();
if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error("ENGINE_COMMIT must contain a 40-character git commit");
const prebuiltRuntimeDir = process.env.VIBE_CLOUD_RUNTIME_DIR?.trim()
  ? resolve(process.env.VIBE_CLOUD_RUNTIME_DIR)
  : undefined;

const candidates = [
  process.env.VIBE_CODR_ROOT && resolve(process.env.VIBE_CODR_ROOT),
  resolve(root, "..", ".."),
  resolve(root, "..", "cli"),
  resolve(root, "..", "vibe-codr"),
  join(homedir(), "Code", "vibe-codr"),
  join(homedir(), "code", "vibe-codr"),
].filter(Boolean);
const engineRoot = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
if (!prebuiltRuntimeDir && !engineRoot) throw new Error("vibe-codr checkout not found; set VIBE_CODR_ROOT or VIBE_CLOUD_RUNTIME_DIR before packaging");

const CLOUD_RUNTIME_BUILD_INPUT_PATHS = [
  "bun.lock",
  "package.json",
  "tsconfig.base.json",
  "scripts/build-cloud-runtime.mjs",
  "packages/cloud-agentd/package.json",
  "packages/cloud-agentd/tsconfig.json",
  "packages/cloud-agentd/bin",
  "packages/cloud-agentd/src",
  "packages/config/package.json",
  "packages/config/src",
  "packages/core/package.json",
  "packages/core/src",
  "packages/macos-bridge/package.json",
  "packages/macos-bridge/bin",
  "packages/macos-bridge/src",
  "packages/plugins/package.json",
  "packages/plugins/src",
  "packages/providers/package.json",
  "packages/providers/src",
  "packages/shared/package.json",
  "packages/shared/src",
  "packages/tools/package.json",
  "packages/tools/src",
];

if (!prebuiltRuntimeDir) {
  const checkoutRevision = execFileSync("git", ["-C", engineRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (checkoutRevision !== revision) {
    throw new Error(`Refusing to stage cloud runtime ${checkoutRevision}; Electron locks ${revision}`);
  }
  const dirtyRuntime = execFileSync(
    "git",
    ["-C", engineRoot, "status", "--porcelain", "--untracked-files=all", "--", ...CLOUD_RUNTIME_BUILD_INPUT_PATHS],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  ).trim();
  if (dirtyRuntime) {
    throw new Error(
      `Refusing to stage a runtime-dirty engine checkout at ${engineRoot}:\n${dirtyRuntime}\n` +
      "Commit the engine changes, update ENGINE_COMMIT, and retry.",
    );
  }

  execFileSync("bun", ["run", "build:cloud-runtime"], {
    cwd: engineRoot,
    env: { ...process.env, VIBE_ENGINE_COMMIT: revision },
    stdio: "inherit",
  });
}

const name = `vibe-cloud-runtime-${revision.slice(0, 12)}.tar.gz`;
const sourceDir = prebuiltRuntimeDir ?? join(engineRoot, "dist", "cloud-runtime");
const archive = join(sourceDir, name);
const checksum = `${archive}.sha256`;
if (!existsSync(archive) || !existsSync(checksum)) throw new Error("Cloud runtime build did not produce its archive and checksum");
const expected = readFileSync(checksum, "utf8").trim().split(/\s+/)[0];
const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
if (!expected || expected !== actual) throw new Error("Cloud runtime archive checksum verification failed");

const destination = join(root, "resources", "cloud-runtime");
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
copyFileSync(archive, join(destination, name));
copyFileSync(checksum, join(destination, `${name}.sha256`));
console.log(`Staged revision-locked cloud runtime ${revision} from ${sourceDir} → ${destination}`);
