import { describe, expect, it } from "vitest";
import { assertGitRef, assertGitRemote, isSafeGitRef } from "./git-ref";
import { parsePorcelainZ, createBranch } from "./git-ops";

describe("assertGitRef", () => {
  it("accepts normal branch names", () => {
    expect(assertGitRef("feature/login")).toBe("feature/login");
    expect(assertGitRef("main")).toBe("main");
  });

  it("rejects leading-dash names that would become git options", () => {
    expect(() => assertGitRef("--output=/tmp/x")).toThrow(/must not start with/);
    expect(() => assertGitRef("-D")).toThrow(/must not start with/);
    expect(isSafeGitRef("--force")).toBe(false);
  });

  it("rejects empty and control characters", () => {
    expect(() => assertGitRef("")).toThrow(/required/);
    expect(() => assertGitRef("a\nb")).toThrow(/control/);
  });

  it("validates remotes the same way", () => {
    expect(assertGitRemote("origin")).toBe("origin");
    expect(() => assertGitRemote("-u")).toThrow(/must not start with/);
  });
});

describe("parsePorcelainZ", () => {
  it("parses ordinary and space-containing paths from -z status", () => {
    // Two records: modified file, untracked with spaces
    const raw = " M src/app.ts\0?? my file.txt\0";
    const entries = parsePorcelainZ(raw);
    expect(entries).toEqual([
      { index: " ", working: "M", path: "src/app.ts" },
      { index: "?", working: "?", path: "my file.txt" },
    ]);
  });

  it("parses rename records with two path fields", () => {
    const raw = "R  new-name.ts\0old-name.ts\0";
    const entries = parsePorcelainZ(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.index).toBe("R");
    expect(entries[0]!.path).toBe("new-name.ts");
    expect(entries[0]!.oldPath).toBe("old-name.ts");
  });
});

describe("createBranch ref safety", () => {
  it("returns a structured error for option-like branch names without spawning", async () => {
    const result = await createBranch("/tmp", "--delete");
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/must not start with/);
  });
});
