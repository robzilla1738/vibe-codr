import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Vite config for the browser UI preview (mocked `window.vibe`, no Electron). */
export default defineConfig({
  root: here,
  // Keep the dep-optimizer cache inside this folder so a checkout that shares
  // node_modules (e.g. a git worktree) never collides with the main tree.
  cacheDir: fileURLToPath(new URL("./.vite-cache", import.meta.url)),
  plugins: [react()],
  server: {
    port: 4517,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
});
