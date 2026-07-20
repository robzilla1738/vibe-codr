import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("canonical protocol Metro alias", () => {
  it("watches and resolves the canonical protocol source", () => {
    const config = require("../../metro.config.js") as {
      watchFolders: string[];
      server: { unstable_serverRoot: string };
      resolver: {
        resolveRequest: (
          context: { originModulePath: string; resolveRequest: () => never },
          moduleName: string,
          platform: string,
        ) => { type: string; filePath: string };
      };
    };
    const protocolEntry = path.resolve(__dirname, "..", "..", "..", "..", "..", "packages", "protocol", "src", "index.ts");
    const protocolRoot = path.dirname(protocolEntry);
    expect(config.server.unstable_serverRoot).toBe(path.resolve(protocolRoot, "..", "..", ".."));
    expect(config.watchFolders).toContain(protocolRoot);
    expect(config.resolver.resolveRequest({
      originModulePath: import.meta.filename,
      resolveRequest: () => { throw new Error("fallback should not run"); },
    }, "@vibe/protocol", "web")).toEqual({ type: "sourceFile", filePath: protocolEntry });
  });
});
