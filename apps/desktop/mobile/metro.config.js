const { getDefaultConfig } = require("expo/metro-config");
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
// The Electron app's pure shared contract layer is the single source of truth.
const sharedRoot = path.resolve(projectRoot, "..", "src", "shared");
const electronRoot = path.resolve(projectRoot, "..");
const hooksRoot = path.resolve(electronRoot, "src", "renderer", "hooks");
const relayRoot = path.resolve(electronRoot, "relay");

const config = getDefaultConfig(projectRoot);

// Keep Expo's native-tooling project root on mobile, but widen Metro's server
// boundary so its file map can hash the shared Electron source. This is the
// supported monorepo boundary in Metro 0.83 and keeps Hermes resolution local.
config.server.unstable_serverRoot = electronRoot;
config.watchFolders = [sharedRoot, hooksRoot, relayRoot];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Expo forms the entry request relative to the app root, while Metro serves
  // from the wider graph root above. Preserve the app entry explicitly.
  if (moduleName === "./index.ts") {
    return { type: "sourceFile", filePath: path.join(projectRoot, "index.ts") };
  }
  return context.resolveRequest(context, moduleName, platform);
};
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(electronRoot, "node_modules"),
];

// Metro 0.83 no longer consumes the old non-standard `resolver.alias` field.
// Register each source module through supported `extraNodeModules` resolution;
// unlike a custom resolver, this keeps external files in Metro's file map so
// production exports can hash them correctly.
const sourceModules = (prefix, root) =>
  Object.fromEntries(
    fs
      .readdirSync(root)
      .filter((name) => /\.(?:ts|tsx|js|jsx)$/.test(name) && !name.includes(".test."))
      .map((name) => [
        `${prefix}/${name.replace(/\.(?:ts|tsx|js|jsx)$/, "")}`,
        path.join(root, name),
      ]),
  );

// The shared layer is Node-targeted; a few modules import node builtins for the
// desktop-only paths (git-ops, config-io, editor-compose, cwd-allowlist). The
// mobile app never calls those code paths, but Metro must still resolve the
// bare specifiers at bundle time. Map them to RN-safe shims so the shared
// source stays untouched (single source of truth, zero forks).
const shimsDir = path.resolve(projectRoot, "src", "shims");
const nodeShim = (name) => path.resolve(shimsDir, `${name}.js`);
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  ...sourceModules("@shared", sharedRoot),
  ...sourceModules("@hooks", hooksRoot),
  ...sourceModules("@relay", relayRoot),
  path: nodeShim("path"),
  "node:path": nodeShim("path"),
  crypto: nodeShim("crypto"),
  "node:crypto": nodeShim("crypto"),
  fs: nodeShim("fs"),
  "node:fs": nodeShim("fs"),
  "node:fs/promises": nodeShim("fs"),
  os: nodeShim("os"),
  "node:os": nodeShim("os"),
  stream: nodeShim("stream"),
  "node:stream": nodeShim("stream"),
  child_process: nodeShim("child_process"),
  "node:child_process": nodeShim("child_process"),
};

// Allow resolving .ts/.tsx from the shared tree.
config.resolver.sourceExts = [...config.resolver.sourceExts, "ts", "tsx"];

module.exports = config;
