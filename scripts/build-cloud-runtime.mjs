import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "dist", "cloud-runtime");
const stage = join(output, "stage");
const revision = run("git", ["rev-parse", "HEAD"], root).trim();
const expected = readFileSync(join(root, "..", "vbcode-electron", "ENGINE_COMMIT"), "utf8").trim();
if (revision !== expected) throw new Error(`ENGINE_COMMIT mismatch: runtime ${revision}, desktop ${expected}`);

rmSync(output, { recursive: true, force: true });
mkdirSync(join(stage, "packages"), { recursive: true });

run("bun", ["build", "packages/macos-bridge/bin/engine-host.ts", "--compile", "--target=bun-linux-x64", "--outfile", join(stage, "vibecodr-engine-host")], root);
run("bun", ["build", "packages/cloud-agentd/bin/cloud-agentd.ts", "--target=node", "--external", "node-pty", "--external", "ws", "--outfile", join(stage, "cloud-agentd.mjs")], root);
run("bun", ["build", "packages/cloud-agentd/bin/cloud-bootstrap.ts", "--target=node", "--outfile", join(stage, "vibe-cloud-bootstrap.mjs")], root);
run("bun", ["build", "packages/cloud-agentd/bin/cloud-export.ts", "--target=node", "--outfile", join(stage, "vibe-cloud-export.mjs")], root);

for (const spec of ["node-pty@1.1.0", "ws@8.18.3"]) {
  const packed = run("npm", ["pack", spec, "--pack-destination", join(stage, "packages")], root).trim().split("\n").at(-1);
  if (!packed) throw new Error(`npm pack produced no artifact for ${spec}`);
}

writeFileSync(join(stage, "package.json"), `${JSON.stringify({ private: true, type: "module", engines: { node: ">=24" } }, null, 2)}\n`);
const verifiedFiles = ["vibecodr-engine-host", "vibe-cloud-bootstrap.mjs", "vibe-cloud-export.mjs", "cloud-agentd.mjs", "package.json"];
const verifiedPackages = ["node-pty-1.1.0.tgz", "ws-8.18.3.tgz"];
writeFileSync(join(stage, "checksums.sha256"), `${[
  ...verifiedFiles.map((name) => `${sha256(readFileSync(join(stage, name)))}  ${name}`),
  ...verifiedPackages.map((name) => `${sha256(readFileSync(join(stage, "packages", name)))}  packages/${name}`),
].join("\n")}\n`);
writeFileSync(join(stage, "install-runtime.sh"), `#!/bin/sh\nset -eu\nsha256sum -c checksums.sha256\nnpm install --omit=dev --no-audit --no-fund ./packages/node-pty-1.1.0.tgz ./packages/ws-8.18.3.tgz\n`, { mode: 0o755 });
writeFileSync(join(stage, "start.sh"), `#!/bin/sh\nset -eu\nexport VIBE_ENGINE_HOST=\"$PWD/vibecodr-engine-host\"\nexec node cloud-agentd.mjs\n`, { mode: 0o755 });

const files = ["vibecodr-engine-host", "vibe-cloud-bootstrap.mjs", "vibe-cloud-export.mjs", "cloud-agentd.mjs", "package.json", "checksums.sha256", "install-runtime.sh", "start.sh"]
  .map((name) => ({ name, sha256: sha256(readFileSync(join(stage, name))) }));
const packages = verifiedPackages.map((name) => ({ name, sha256: sha256(readFileSync(join(stage, "packages", name))) }));
writeFileSync(join(stage, "runtime.json"), `${JSON.stringify({ schemaVersion: 1, engineRevision: revision, node: "24", files, packages }, null, 2)}\n`);
writeFileSync(join(stage, "sbom.spdx.json"), `${JSON.stringify({ spdxVersion: "SPDX-2.3", name: `vibe-cloud-runtime-${revision.slice(0, 12)}`, packages: [
  { name: "vibe-codr-engine-host", versionInfo: revision, downloadLocation: "NOASSERTION" },
  { name: "cloud-agentd", versionInfo: revision, downloadLocation: "NOASSERTION" },
  { name: "node-pty", versionInfo: "1.1.0", downloadLocation: "https://registry.npmjs.org/node-pty" },
  { name: "ws", versionInfo: "8.18.3", downloadLocation: "https://registry.npmjs.org/ws" },
] }, null, 2)}\n`);

const archive = join(output, `vibe-cloud-runtime-${revision.slice(0, 12)}.tar.gz`);
run("tar", ["-czf", archive, "-C", stage, "."], root);
const digest = sha256(readFileSync(archive));
writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
process.stdout.write(`${archive}\n${digest}\n`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  return result.stdout;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
