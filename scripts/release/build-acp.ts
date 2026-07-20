#!/usr/bin/env bun
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const out = join(root, "dist", "acp");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const outfile = join(out, "vibe-acp.js");
const result = await Bun.build({
  entrypoints: [join(root, "packages", "acp", "bin", "vibe-acp.ts")],
  target: "bun",
  outdir: out,
  naming: "vibe-acp.js",
});
if (!result.success) throw new Error(`ACP build failed: ${result.logs.join("\n")}`);
const version = (await import(join(root, "packages", "cli", "src", "version.ts"))).VERSION;
writeFileSync(join(out, "package.json"), `${JSON.stringify({
  name: "@vibe/acp", version, type: "module", bin: { "vibe-acp": "vibe-acp.js" },
  engines: { bun: ">=1.2.0" }, files: ["vibe-acp.js", "README.md", "LICENSE"], license: "MIT",
}, null, 2)}\n`);
cpSync(join(root, "README.md"), join(out, "README.md"));
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
chmodSync(outfile, 0o755);
console.log(`Built ACP package at ${out}`);
