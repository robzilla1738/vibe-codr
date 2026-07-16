import { describe, expect, it } from "vitest";
import { pluginSpecifiersFromLines, validatePluginSpecifiers } from "./plugin-specifiers";

describe("plugin specifiers", () => {
  it("normalizes the line editor without changing first-seen order", () => {
    expect(pluginSpecifiersFromLines(" pkg-a \n\n./local.ts\npkg-a\r\n")).toEqual([
      "pkg-a",
      "./local.ts",
    ]);
  });

  it("rejects entries that are empty, padded, duplicated, or contain controls", () => {
    const errors = validatePluginSpecifiers(["pkg-a", " pkg-b", "", "pkg-a", "bad\u0000name"]);
    expect(errors).toContain("plugins[1]: must not have leading or trailing whitespace");
    expect(errors).toContain("plugins[2]: must not be empty");
    expect(errors).toContain("plugins[3]: duplicates an earlier plugin module");
    expect(errors).toContain("plugins[4]: must not contain control characters");
  });

  it("accepts npm, scoped-package, and local-path forms", () => {
    expect(validatePluginSpecifiers(["vibe-plugin", "@scope/plugin", "./plugins/local.ts"])).toEqual([]);
  });
});
