#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SdkPackageMetadataOptions {
  version: string;
  repository?: unknown;
  funding?: unknown;
}

export function generateSdkPackageJson(options: SdkPackageMetadataOptions): Record<string, unknown> {
  return {
    name: "@vibe/sdk",
    version: options.version,
    description: "Typed authenticated loopback SDK for Vibe Codr",
    license: "MIT",
    type: "module",
    exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
    main: "./index.js",
    types: "./index.d.ts",
    files: ["index.js", "index.d.ts", "integrity.json", "README.md", "LICENSE"],
    engines: { node: ">=18" },
    ...(options.repository ? { repository: options.repository } : {}),
    ...(options.funding ? { funding: options.funding } : {}),
  };
}

export async function sha256File(path: string): Promise<string> {
  return `sha256-${createHash("sha256").update(await readFile(path)).digest("base64")}`;
}

export async function verifySdkIntegrity(directory: string): Promise<boolean> {
  const manifest = JSON.parse(await readFile(join(directory, "integrity.json"), "utf8")) as {
    algorithm: string;
    files: Record<string, string>;
  };
  if (manifest.algorithm !== "sha256") return false;
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (await sha256File(join(directory, file)).catch(() => "") !== expected) return false;
  }
  return true;
}

export async function buildSdk(root = join(import.meta.dir, "..", "..")): Promise<string> {
  const output = join(root, "dist", "sdk");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(root, "packages", "sdk", "src", "index.ts")],
    outdir: output,
    naming: "index.js",
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!result.success) throw new Error(`SDK build failed: ${result.logs.map((log) => log.message).join("\n")}`);
  await cp(join(root, "packages", "sdk", "types", "index.d.ts"), join(output, "index.d.ts"));
  await cp(join(root, "README.md"), join(output, "README.md"));
  await cp(join(root, "LICENSE"), join(output, "LICENSE"));
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version: string;
    repository?: unknown;
    funding?: unknown;
  };
  const packageJson = generateSdkPackageJson(rootPackage);
  await writeFile(join(output, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  const files = ["index.js", "index.d.ts", "package.json", "README.md", "LICENSE"];
  const integrity = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await sha256File(join(output, file))])));
  await writeFile(join(output, "integrity.json"), `${JSON.stringify({ algorithm: "sha256", files: integrity }, null, 2)}\n`);
  if (!await verifySdkIntegrity(output)) throw new Error("generated SDK integrity verification failed");
  return output;
}

if (import.meta.main) {
  const output = await buildSdk();
  process.stdout.write(`Built @vibe/sdk at ${output}\n`);
}
