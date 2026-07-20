import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("canonical protocol production bundling contract", () => {
  it("aliases and bundles protocol source in every Electron target", () => {
    const config = readFileSync(new URL("../../electron.vite.config.ts", import.meta.url), "utf8");
    expect(config).toContain('const protocolSource = resolve("../../packages/protocol/src/index.ts")');
    expect(config.match(/resolve: \{ alias: protocolAlias \}/g)).toHaveLength(2);
    expect(config).toContain('...protocolAlias');
    expect(config.match(/exclude: \["@vibe\/protocol"\]/g)).toHaveLength(2);
  });

  it("maps canonical source for both Electron TypeScript programs", () => {
    for (const file of ["../../tsconfig.node.json", "../../tsconfig.web.json"]) {
      const config = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as {
        compilerOptions?: { paths?: Record<string, string[]> };
      };
      expect(config.compilerOptions?.paths?.["@vibe/protocol"])
        .toEqual(["../../packages/protocol/src/index.ts"]);
    }
  });

  it("maps the same source in desktop unit tests", () => {
    const config = readFileSync(new URL("../../vitest.config.ts", import.meta.url), "utf8");
    expect(config).toContain('"@vibe/protocol": resolve("../../packages/protocol/src/index.ts")');
  });
});
