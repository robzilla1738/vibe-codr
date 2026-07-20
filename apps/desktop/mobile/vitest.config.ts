import { defineConfig } from "vitest/config";
import path from "node:path";

const sharedRoot = path.resolve(__dirname, "..", "src", "shared");
const hooksRoot = path.resolve(__dirname, "..", "src", "renderer", "hooks");
const protocolSource = path.resolve(__dirname, "..", "..", "..", "packages", "protocol", "src", "index.ts");

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@vibe/protocol": protocolSource,
      "@shared": sharedRoot,
      "@hooks": hooksRoot,
    },
  },
});
