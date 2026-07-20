import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const outDir = resolve(process.argv[2] ?? join(root, "dist", "standalone", "vibe-codr"));
const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
const target = targetArg?.slice("--target=".length);
const windows = target?.includes("windows") ?? process.platform === "win32";
const ext = windows ? ".exe" : "";

function run(command: string[], cwd = root, env?: Record<string, string>): void {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const targetFlags = target ? [`--target=${target}`] : [];
run([
  "bun", "build", "--compile", ...targetFlags,
  "packages/cli/bin/vibecodr.ts", "--outfile", join(outDir, `vibecodr${ext}`),
]);
run([
  "bun", "build", "--compile", ...targetFlags,
  "packages/cli/src/engine-worker-entry.ts", "--outfile", join(outDir, `vibecodr-engine-worker${ext}`),
]);
run([
  "bun", "build", "--compile", ...targetFlags,
  "packages/plugins/src/worker-entry.ts", "--outfile", join(outDir, `vibecodr-plugin-worker${ext}`),
]);
run(["bun", "scripts/release/build-app.ts", join(outDir, "vibecodr-app.js")]);

const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
  dependencies?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
};
const mcpSdkVersion = rootPackage.dependencies?.["@modelcontextprotocol/sdk"];
if (!mcpSdkVersion) throw new Error("root package.json must pin @modelcontextprotocol/sdk for standalone MCP support");
const mcpRuntimeDir = join(outDir, "runtime");
mkdirSync(mcpRuntimeDir, { recursive: true });
for (const module of ["index", "stdio", "sse", "streamableHttp"]) {
  run([
    "bun",
    "build",
    join(root, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", `${module}.js`),
    "--target=bun",
    "--outfile",
    join(mcpRuntimeDir, `mcp-client-${module}.js`),
  ]);
}
cpSync(join(root, "node_modules", "@modelcontextprotocol", "sdk", "LICENSE"), join(mcpRuntimeDir, "MCP-SDK-LICENSE"));
writeFileSync(join(mcpRuntimeDir, "mcp-sdk.json"), `${JSON.stringify({ name: "@modelcontextprotocol/sdk", version: mcpSdkVersion })}\n`);
writeFileSync(join(outDir, "package.json"), `${JSON.stringify({
  name: "vibe-codr-standalone-runtime",
  version: rootPackage.version,
  private: true,
  type: "module",
  dependencies: {
    "@opentui/core": "0.4.2",
    "@opentui/solid": "0.4.2",
    "solid-js": "1.9.12",
    "web-tree-sitter": "0.25.10",
  },
  patchedDependencies: rootPackage.patchedDependencies,
}, null, 2)}\n`);

if (rootPackage.patchedDependencies && existsSync(join(root, "patches"))) {
  cpSync(join(root, "patches"), join(outDir, "patches"), { recursive: true });
}
run(["bun", "install", "--production", "--no-progress"], outDir);

for (const file of ["README.md", "CHANGELOG.md", "LICENSE"]) {
  cpSync(join(root, file), join(outDir, file));
}
for (const lock of ["bun.lock", "bun.lockb"]) {
  const path = join(outDir, lock);
  if (existsSync(path)) unlinkSync(path);
}

const main = join(outDir, `vibecodr${ext}`);
run([main, "--version"], outDir);
run([main], outDir, { VIBE_RELEASE_RUNTIME_SMOKE: "mcp" });
run([
  "bun", "-e",
  'await import("./node_modules/@opentui/solid/scripts/preload.js"); const app = await import("./vibecodr-app.js"); if (typeof app.mountApp !== "function") throw new Error("standalone TUI bundle is invalid");',
], outDir);

console.log(`Built platform-complete standalone runtime at ${basename(outDir)}`);
