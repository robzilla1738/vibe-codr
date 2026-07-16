import { describe, expect, it } from "vitest";
import { buildPushArgs } from "./git-ops";

describe("buildPushArgs (shipped push argv)", () => {
  it("force:true emits --force-with-lease only", () => {
    const args = buildPushArgs({ force: true });
    expect(args.includes("--force-with-lease")).toBe(true);
    expect(args.includes("--force")).toBe(false);
    // Exact order used by pushBranch → runGit
    expect(args).toEqual(["push", "--force-with-lease", "origin"]);
  });

  it("forceUnsafe:true emits bare --force only", () => {
    const args = buildPushArgs({ forceUnsafe: true, remote: "upstream", branch: "main" });
    expect(args.includes("--force")).toBe(true);
    expect(args.includes("--force-with-lease")).toBe(false);
    expect(args).toEqual(["push", "--force", "upstream", "main"]);
  });
});
