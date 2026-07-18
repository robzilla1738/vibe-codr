import { defineConfig } from "vitest/config";
import path from "node:path";

const sharedRoot = path.resolve(__dirname, "..", "src", "shared");
const hooksRoot = path.resolve(__dirname, "..", "src", "renderer", "hooks");

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@shared": sharedRoot,
      "@hooks": hooksRoot,
    },
  },
});
