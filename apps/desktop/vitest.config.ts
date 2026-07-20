import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "relay/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      // Floors start on the highest-risk pure/main modules; raise over time.
      include: [
        "src/shared/**/*.ts",
        "src/main/engine-bridge.ts",
        "src/main/host-resolver.ts",
        "src/main/ipc-security.ts",
      ],
      exclude: ["src/**/*.test.ts", "src/shared/improvement-audit.test.ts"],
      thresholds: {
        // Honest baseline — not 100%; fail CI if coverage regresses below this.
        lines: 55,
        functions: 50,
        branches: 45,
        statements: 55,
      },
    },
  },
  resolve: {
    alias: {
      "@vibe/protocol": resolve("../../packages/protocol/src/index.ts"),
      "@shared": resolve("src/shared"),
    },
  },
});
