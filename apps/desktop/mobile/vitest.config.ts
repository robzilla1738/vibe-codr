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
      "@vibe/protocol/client-runtime": path.resolve(__dirname, "..", "..", "..", "packages", "protocol", "src", "client-runtime.ts"),
      "@vibe/protocol/domain": path.resolve(__dirname, "..", "..", "..", "packages", "protocol", "src", "domain.ts"),
      "@vibe/protocol/host-v2": path.resolve(__dirname, "..", "..", "..", "packages", "protocol", "src", "host-v2.ts"),
      "@vibe/protocol/project": path.resolve(__dirname, "..", "..", "..", "packages", "protocol", "src", "project.ts"),
      "@vibe/protocol": protocolSource,
      "@shared": sharedRoot,
      "@hooks": hooksRoot,
    },
  },
});
