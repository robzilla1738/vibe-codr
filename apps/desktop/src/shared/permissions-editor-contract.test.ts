import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("permission editor scope contract", () => {
  const source = readFileSync(
    join(process.cwd(), "src/renderer/settings/sections/PermissionsSection.tsx"),
    "utf8",
  );

  it("clears the competing scope when glob or exact matching is selected", () => {
    expect(source).toContain("...(v ? { matchExact: undefined } : {})");
    expect(source).toContain("...(v ? { match: undefined } : {})");
    expect(source).toContain("setting one clears the other");
  });
});
