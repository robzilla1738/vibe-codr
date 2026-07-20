#!/usr/bin/env bun
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const source = join(root, "extensions", "vscode");
const extensionDir = join(root, "dist", "vscode", "extension");
const archive = join(root, "dist", "vscode", "vibe-codr.vsix");
rmSync(join(root, "dist", "vscode"), { recursive: true, force: true });
mkdirSync(join(extensionDir, "dist"), { recursive: true });
const result = await Bun.build({
  entrypoints: [join(source, "src", "extension.ts")],
  target: "node",
  format: "cjs",
  external: ["vscode"],
  outdir: join(extensionDir, "dist"),
  naming: "extension.js",
});
if (!result.success) throw new Error(`VS Code extension build failed: ${result.logs.join("\n")}`);
const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
manifest.name = "vibe-codr";
delete manifest.scripts;
delete manifest.dependencies;
delete manifest.devDependencies;
writeFileSync(join(extensionDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(root, "README.md"), join(extensionDir, "README.md"));
cpSync(join(root, "LICENSE"), join(extensionDir, "LICENSE"));
const zipped = Bun.spawnSync(["zip", "-qr", archive, "extension"], { cwd: join(root, "dist", "vscode") });
if (zipped.exitCode !== 0) throw new Error(zipped.stderr.toString() || "VSIX archive failed");
console.log(`Built VS Code extension at ${archive}`);
