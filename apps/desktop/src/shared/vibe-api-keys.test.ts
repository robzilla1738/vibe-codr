import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VIBE_API_KEYS } from "./vibe-api-keys";

describe("VibeApi key contract", () => {
  it("preload api object defines every canonical key", () => {
    const preload = readFileSync(join(process.cwd(), "src/preload/index.ts"), "utf8");
    // Extract the api object block
    const start = preload.indexOf("const api: VibeApi = {");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = preload.indexOf("};\n\ncontextBridge", start);
    const block = preload.slice(start, end > start ? end : undefined);
    for (const key of VIBE_API_KEYS) {
      expect(block.includes(`${key}:`) || block.includes(`${key}(`), `preload missing ${key}`).toBe(
        true,
      );
    }
  });

  it("ui-preview mock implements every canonical key", () => {
    const mock = readFileSync(join(process.cwd(), "tools/ui-preview/mock-vibe.ts"), "utf8");
    for (const key of VIBE_API_KEYS) {
      // Methods appear as `key:` or `key(` in the mock object
      const present =
        mock.includes(`${key}:`) ||
        mock.includes(`${key}(`) ||
        mock.includes(`async ${key}(`);
      expect(present, `mock-vibe missing ${key}`).toBe(true);
    }
  });
});
