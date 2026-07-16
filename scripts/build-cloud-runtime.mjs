import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const DEFAULT_RUNTIME_IMAGE = "node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059";
const output = join(root, "dist", "cloud-runtime");
const stage = join(output, "stage");
const revision = run("git", ["rev-parse", "HEAD"], root).trim();
const desktopLock = [
  join(root, "..", "electron", "ENGINE_COMMIT"),
  join(root, "..", "vbcode-electron", "ENGINE_COMMIT"),
].find(existsSync);
const expected = process.env.VIBE_ENGINE_COMMIT?.trim()
  || (desktopLock ? readFileSync(desktopLock, "utf8").trim() : "");
if (!expected) throw new Error("ENGINE_COMMIT is unavailable; set VIBE_ENGINE_COMMIT or place the Electron checkout beside the engine");
if (revision !== expected) throw new Error(`ENGINE_COMMIT mismatch: runtime ${revision}, desktop ${expected}`);

rmSync(output, { recursive: true, force: true });
mkdirSync(join(stage, "packages"), { recursive: true });
mkdirSync(join(stage, "bin"), { recursive: true });

run("bun", ["build", "packages/macos-bridge/bin/engine-host.ts", "--compile", "--target=bun-linux-x64", "--outfile", join(stage, "vibecodr-engine-host")], root);
run("bun", ["build", "packages/cloud-agentd/bin/cloud-agentd.ts", "--target=node", "--external", "node-pty", "--external", "ws", "--outfile", join(stage, "cloud-agentd.mjs")], root);
run("bun", ["build", "packages/cloud-agentd/bin/cloud-bootstrap.ts", "--target=node", "--outfile", join(stage, "vibe-cloud-bootstrap.mjs")], root);
run("bun", ["build", "packages/cloud-agentd/bin/cloud-export.ts", "--target=node", "--outfile", join(stage, "vibe-cloud-export.mjs")], root);

for (const spec of ["node-pty@1.1.0", "node-addon-api@7.1.1", "ws@8.18.3"]) {
  const packed = run("npm", ["pack", "--silent", spec, "--pack-destination", join(stage, "packages")], root).trim().split("\n").at(-1);
  if (!packed) throw new Error(`npm pack produced no artifact for ${spec}`);
}

sanitizeLinuxPackage("node-pty-1.1.0.tgz");

const verifiedPackages = ["node-pty-1.1.0.tgz", "node-addon-api-7.1.1.tgz", "ws-8.18.3.tgz"];
writeFileSync(join(stage, "package.json"), `${JSON.stringify({
  private: true,
  type: "module",
  engines: { node: ">=24" },
  dependencies: {
    "node-pty": "file:packages/node-pty-1.1.0.tgz",
    "node-addon-api": "file:packages/node-addon-api-7.1.1.tgz",
    ws: "file:packages/ws-8.18.3.tgz",
  },
}, null, 2)}\n`);

installLinuxDependencies();
assertLinuxRuntime();

writeFileSync(join(stage, "install-runtime.sh"), `#!/bin/sh
set -eu
if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "cloud runtime requires Linux x86_64" >&2
  exit 1
fi
sha256sum --quiet -c checksums.sha256
./bin/node -e 'if (process.versions.node !== "24.18.0") throw new Error("Bundled Node 24.18.0 is required, found " + process.version); require("node-pty"); require("ws")'
`, { mode: 0o755 });
writeFileSync(join(stage, "restore-session.sh"), `#!/bin/sh
set -eu
if [ "$(id -u)" -ne 0 ]; then
  echo "cloud session restore must run as root so it can enter the isolated workload identity" >&2
  exit 1
fi
if [ "$#" -ne 3 ]; then
  echo "usage: restore-session.sh <bundle.json> <target-root> <engine-revision>" >&2
  exit 1
fi
if ! command -v runuser >/dev/null 2>&1; then
  echo "cloud runtime requires runuser to restore under the isolated workload identity" >&2
  exit 1
fi
if ! id -u vibe-workload >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash vibe-workload
  else
    echo "cloud runtime cannot create the isolated workload user" >&2
    exit 1
  fi
fi
VIBE_CLOUD_WORKLOAD_UID="$(id -u vibe-workload)"
VIBE_CLOUD_WORKLOAD_GID="$(id -g vibe-workload)"
VIBE_CLOUD_WORKLOAD_HOME="$(getent passwd vibe-workload | cut -d: -f6)"
BUNDLE="$1"
TARGET="$2"
REVISION="$3"
TARGET_PARENT="$(dirname "$TARGET")"
mkdir -p "$TARGET_PARENT" "$VIBE_STATE_DIR"
chown "$VIBE_CLOUD_WORKLOAD_UID:$VIBE_CLOUD_WORKLOAD_GID" "$TARGET_PARENT" "$VIBE_STATE_DIR" "$BUNDLE"
chmod 0400 "$BUNDLE"
RUNTIME_PARENT="$PWD"
while [ "$RUNTIME_PARENT" != "/" ]; do
  chmod o+x "$RUNTIME_PARENT"
  RUNTIME_PARENT="$(dirname "$RUNTIME_PARENT")"
done
exec runuser -u vibe-workload --preserve-environment -- env \
  HOME="$VIBE_CLOUD_WORKLOAD_HOME" \
  USER=vibe-workload \
  LOGNAME=vibe-workload \
  VIBE_STATE_DIR="$VIBE_STATE_DIR" \
  "$PWD/bin/node" "$PWD/vibe-cloud-bootstrap.mjs" "$BUNDLE" "$TARGET" "$REVISION"
`, { mode: 0o755 });
writeFileSync(join(stage, "start.sh"), `#!/bin/sh
set -eu
if [ "$#" -ne 1 ] || { [ "$1" != "e2b" ] && [ "$1" != "vercel" ]; }; then
  echo "usage: start.sh <e2b|vercel>" >&2
  exit 1
fi
CLOUD_PROVIDER="$1"
if [ "$(id -u)" -ne 0 ]; then
  echo "cloud-agentd must start as root so project workloads can run under an isolated identity" >&2
  exit 1
fi
if ! id -u vibe-workload >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash vibe-workload
  else
    echo "cloud runtime cannot create the isolated workload user" >&2
    exit 1
  fi
fi
VIBE_CLOUD_WORKLOAD_UID="$(id -u vibe-workload)"
VIBE_CLOUD_WORKLOAD_GID="$(id -g vibe-workload)"
VIBE_CLOUD_WORKLOAD_HOME="$(getent passwd vibe-workload | cut -d: -f6)"
export VIBE_CLOUD_WORKLOAD_UID VIBE_CLOUD_WORKLOAD_GID VIBE_CLOUD_WORKLOAD_HOME
export VIBE_CLOUD_REQUIRE_ISOLATION=1
mkdir -p "$VIBE_WORKSPACE_ROOT" "$VIBE_STATE_DIR"
chown -R "$VIBE_CLOUD_WORKLOAD_UID:$VIBE_CLOUD_WORKLOAD_GID" "$VIBE_WORKSPACE_ROOT" "$VIBE_STATE_DIR"
RUNTIME_PARENT="$PWD"
while [ "$RUNTIME_PARENT" != "/" ]; do
  chmod o+x "$RUNTIME_PARENT"
  RUNTIME_PARENT="$(dirname "$RUNTIME_PARENT")"
done
install -d -m 0700 /run/vibe-cloud
umask 077
printf '%s' "$VIBE_CLOUD_ACCESS_TOKEN" > /run/vibe-cloud/access-token
unset VIBE_CLOUD_ACCESS_TOKEN
export VIBE_CLOUD_ACCESS_TOKEN_FILE=/run/vibe-cloud/access-token
export VIBE_ENGINE_HOST="$PWD/vibecodr-engine-host"
exec "$PWD/bin/node" cloud-agentd.mjs "$CLOUD_PROVIDER"
`, { mode: 0o755 });

const checksumFiles = walk(stage).filter((name) => !["checksums.sha256", "runtime.json", "sbom.spdx.json"].includes(name));
writeFileSync(join(stage, "checksums.sha256"), `${checksumFiles
  .map((name) => `${sha256(readFileSync(join(stage, name)))}  ${name}`)
  .join("\n")}\n`);

const files = ["bin/node", "vibecodr-engine-host", "vibe-cloud-bootstrap.mjs", "vibe-cloud-export.mjs", "cloud-agentd.mjs", "package.json", "package-lock.json", "checksums.sha256", "install-runtime.sh", "restore-session.sh", "start.sh"]
  .map((name) => ({ name, sha256: sha256(readFileSync(join(stage, name))) }));
const packages = verifiedPackages.map((name) => ({ name, sha256: sha256(readFileSync(join(stage, "packages", name))) }));
writeFileSync(join(stage, "runtime.json"), `${JSON.stringify({
  schemaVersion: 1,
  engineRevision: revision,
  platform: "linux",
  arch: "x64",
  libc: "glibc",
  node: "24",
  files,
  packages,
}, null, 2)}\n`);
writeFileSync(join(stage, "sbom.spdx.json"), `${JSON.stringify({ spdxVersion: "SPDX-2.3", name: `vibe-cloud-runtime-${revision.slice(0, 12)}`, packages: [
  { name: "node", versionInfo: "24.18.0", downloadLocation: "https://nodejs.org" },
  { name: "vibe-codr-engine-host", versionInfo: revision, downloadLocation: "NOASSERTION" },
  { name: "cloud-agentd", versionInfo: revision, downloadLocation: "NOASSERTION" },
  { name: "node-pty", versionInfo: "1.1.0", downloadLocation: "https://registry.npmjs.org/node-pty" },
  { name: "node-addon-api", versionInfo: "7.1.1", downloadLocation: "https://registry.npmjs.org/node-addon-api" },
  { name: "ws", versionInfo: "8.18.3", downloadLocation: "https://registry.npmjs.org/ws" },
] }, null, 2)}\n`);

const archive = join(output, `vibe-cloud-runtime-${revision.slice(0, 12)}.tar.gz`);
run("tar", ["--no-xattrs", "-czf", archive, "-C", stage, "."], root);
const digest = sha256(readFileSync(archive));
writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
process.stdout.write(`${archive}\n${digest}\n`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  return result.stdout;
}

function installLinuxDependencies() {
  const install = [
    "npm", "install", "--omit=dev", "--offline", "--no-audit", "--no-fund", "--ignore-scripts=false",
  ];
  const image = process.env.VIBE_CLOUD_RUNTIME_IMAGE || DEFAULT_RUNTIME_IMAGE;
  const identity = typeof process.getuid === "function" && typeof process.getgid === "function"
    ? ["--user", `${process.getuid()}:${process.getgid()}`]
    : [];
  const result = spawnSync("docker", [
    "run", "--rm", "--platform", "linux/amd64",
    ...identity,
    "-e", "HOME=/tmp/vibe-cloud-build",
    "-v", `${stage}:/runtime`, "-w", "/runtime",
    image, "sh", "-lc",
    `mkdir -p "$HOME" && ${install.join(" ")} && cp /usr/local/bin/node /runtime/bin/node`,
  ], { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Linux cloud dependency build failed (${result.status}); start Docker or provide a Linux-built runtime artifact`);
  }
}

function assertLinuxRuntime() {
  const addon = join(stage, "node_modules", "node-pty", "build", "Release", "pty.node");
  if (!existsSync(addon)) throw new Error("Linux node-pty native addon was not produced");
  const magic = readFileSync(addon).subarray(0, 4).toString("hex");
  if (magic !== "7f454c46") throw new Error("Cloud runtime node-pty addon is not a Linux ELF binary");

  const foreignPrebuild = walk(stage).find((name) => /(^|\/)prebuilds\/(darwin|win32)-/.test(name));
  if (foreignPrebuild) throw new Error(`Cloud runtime contains a foreign native prebuild: ${foreignPrebuild}`);

  const foreignBinary = walk(stage).find((name) => {
    const header = readFileSync(join(stage, name)).subarray(0, 4).toString("hex");
    return header.startsWith("4d5a") || ["cafebabe", "feedface", "feedfacf", "cefaedfe", "cffaedfe"].includes(header);
  });
  if (foreignBinary) throw new Error(`Cloud runtime contains a macOS or Windows binary: ${foreignBinary}`);
}

function sanitizeLinuxPackage(name) {
  const archive = join(stage, "packages", name);
  const temporary = mkdtempSync(join(tmpdir(), "vibe-cloud-package-"));
  try {
    run("tar", ["-xzf", archive, "-C", temporary], root);
    rmSync(join(temporary, "package", "prebuilds"), { recursive: true, force: true });
    rmSync(join(temporary, "package", "third_party", "conpty"), { recursive: true, force: true });
    rmSync(archive, { force: true });
    run("tar", ["--no-xattrs", "-czf", archive, "-C", temporary, "package"], root);
    const foreignEntry = run("tar", ["-tzf", archive], root)
      .split("\n")
      .find((entry) => /(^|\/)(prebuilds\/(darwin|win32)-|third_party\/conpty\/)/.test(entry));
    if (foreignEntry) throw new Error(`Sanitized Linux package still contains ${foreignEntry}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function walk(directory, prefix = "") {
  const out = [];
  for (const name of readdirSync(directory).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, relative));
    else out.push(relative);
  }
  return out;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
