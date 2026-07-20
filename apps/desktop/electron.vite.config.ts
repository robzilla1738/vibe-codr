import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

const protocolSource = resolve("../../packages/protocol/src/index.ts");
const protocolAlias = { "@vibe/protocol": protocolSource };

function extractRendererLegalNotices(): Plugin {
  const notices = new Set<string>();
  return {
    name: "extract-renderer-legal-notices",
    enforce: "post",
    buildStart() { notices.clear(); },
    renderChunk(code: string) {
      let changed = false;
      const stripped = code.replace(/\/\*[\s\S]*?\*\//g, (notice: string) => {
        if (!notice.startsWith("/*!") && !/@license|Copyright/i.test(notice)) return notice;
        notices.add(notice.trim());
        changed = true;
        return "";
      });
      return changed ? { code: stripped, map: null } : null;
    },
    generateBundle() {
      if (!notices.size) return;
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_LICENSES.txt",
        source: `Third-party notices extracted from the production renderer bundles.\n\n${[...notices].sort().join("\n\n")}\n`,
      });
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias: protocolAlias },
    plugins: [externalizeDepsPlugin({ exclude: ["@vibe/protocol"] })],
    build: {
      rollupOptions: {
        external: ["electron-liquid-glass"],
        input: {
          index: resolve("src/main/index.ts"),
          relay: resolve("relay/server.ts"),
        },
      },
    },
  },
  preload: {
    resolve: { alias: protocolAlias },
    plugins: [externalizeDepsPlugin({ exclude: ["@vibe/protocol"] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
        },
        // Electron's sandbox executes preload scripts as CommonJS even when the
        // application package uses ESM. Emitting .mjs makes the sandbox loader
        // parse `import` as a syntax error and leaves window.vibe undefined.
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        ...protocolAlias,
        "@shared": resolve("src/shared"),
        "@renderer": resolve("src/renderer"),
      },
    },
    // electron-builder ships the complete out/ tree. Extract repeated /*! ... */
    // notices into one companion file so licenses remain present without making
    // every startup/lazy JavaScript chunk parse the same banners.
    plugins: [react(), extractRendererLegalNotices()],
  },
});
