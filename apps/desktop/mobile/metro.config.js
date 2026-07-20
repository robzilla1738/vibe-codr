const { getDefaultConfig } = require("expo/metro-config");
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..", "..", "..");
// The Electron app's pure shared contract layer is the single source of truth.
const sharedRoot = path.resolve(projectRoot, "..", "src", "shared");
const electronRoot = path.resolve(projectRoot, "..");
const hooksRoot = path.resolve(electronRoot, "src", "renderer", "hooks");
const relayRoot = path.resolve(electronRoot, "relay");
const protocolRoot = path.resolve(projectRoot, "..", "..", "..", "packages", "protocol", "src");

const config = getDefaultConfig(projectRoot);

// Keep Expo's native-tooling project root on mobile, but widen Metro's server
// boundary so its file map can hash both shared Electron and canonical protocol
// source. The app entry remains explicitly rooted below.
config.server.unstable_serverRoot = workspaceRoot;
config.watchFolders = [sharedRoot, hooksRoot, relayRoot, protocolRoot];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@vibe/protocol") {
    return { type: "sourceFile", filePath: path.join(protocolRoot, "index.ts") };
  }
  // Expo forms the entry request relative to the app root, while Metro serves
  // from the wider graph root above. Preserve the app entry explicitly.
  if (moduleName === "./index.ts") {
    return { type: "sourceFile", filePath: path.join(projectRoot, "index.ts") };
  }
  // Relay source uses Node/Vite-correct emitted-JS specifiers. Metro consumes
  // that source directly, so bridge its one runtime shared import back to the
  // TypeScript source instead of searching for an unbuilt sibling `.js` file.
  if (moduleName === "../src/shared/cloud-settings.js"
    && context.originModulePath === path.join(relayRoot, "protocol.ts")) {
    return { type: "sourceFile", filePath: path.join(sharedRoot, "cloud-settings.ts") };
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
