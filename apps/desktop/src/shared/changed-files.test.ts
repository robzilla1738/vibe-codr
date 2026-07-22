import { describe, expect, it } from "vitest";
import {
  buildChangedFileTree,
  changedFileTypeLabel,
  changedFilesHeading,
  changedFilesTotals,
  fileBasename,
  fileParentDir,
  sortChangedFilesForDisplay,
  resolveChangedFileSelection,
} from "./changed-files";

describe("changed-files display helpers", () => {
  const files = [
    { path: "src/a.ts", added: 2, removed: 1 },
    { path: "src/deep/b.ts", added: 20, removed: 5 },
    { path: "README.md", added: 0, removed: 3 },
  ];

  it("basename and parent", () => {
    expect(fileBasename("src/deep/b.ts")).toBe("b.ts");
    expect(fileParentDir("src/deep/b.ts")).toBe("src/deep");
    expect(fileParentDir("README.md")).toBe("");
  });

  it("totals and heading", () => {
    expect(changedFilesTotals(files)).toEqual({ count: 3, added: 22, removed: 9, unknownCount: 0 });
    expect(changedFilesHeading(files)).toBe("3 files changed · +22 −9");
    expect(changedFilesHeading([])).toBe("No files changed");
    expect(changedFilesHeading([files[0]!])).toBe("1 file changed · +2 −1");
  });

  it("labels historical changes without inventing line counts", () => {
    const files = [
      { path: "src/known.ts", added: 2, removed: 1 },
      { path: "src/historical.ts", added: 0, removed: 0, countsKnown: false },
    ];
    expect(changedFilesTotals(files)).toEqual({
      count: 2,
      added: 2,
      removed: 1,
      unknownCount: 1,
    });
    expect(changedFilesHeading(files)).toBe("2 files changed · +2 −1 known");
    expect(changedFilesHeading([files[1]!])).toBe("1 file changed");
  });

  it("sorts by churn then path", () => {
    expect(sortChangedFilesForDisplay(files).map((f) => f.path)).toEqual([
      "src/deep/b.ts",
      "README.md",
      "src/a.ts",
    ]);
  });

  it("builds a deterministic nested tree with root files", () => {
    const tree = buildChangedFileTree([
      { path: "src/z.ts", added: 1, removed: 0 },
      { path: "README.md", added: 0, removed: 1 },
      { path: "src/app/a.tsx", added: 4, removed: 2 },
      { path: "scripts/build.mjs", added: 2, removed: 0 },
    ]);
    expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual([
      "directory:scripts",
      "directory:src",
      "file:README.md",
    ]);
    const src = tree[1];
    expect(src).toMatchObject({
      kind: "directory",
      path: "src",
      files: 2,
      added: 5,
      removed: 2,
      unknownCount: 0,
    });
    if (src?.kind === "directory") {
      expect(src.children.map((node) => `${node.kind}:${node.name}`)).toEqual([
        "directory:app",
        "file:z.ts",
      ]);
    }
  });

  it("normalizes Windows separators and assigns compact file labels", () => {
    const tree = buildChangedFileTree([{ path: "src\\renderer\\App.tsx", added: 1, removed: 1 }]);
    expect(tree[0]).toMatchObject({ kind: "directory", name: "src", path: "src" });
    expect(changedFileTypeLabel("scripts/check.mjs")).toBe("JS");
    expect(changedFileTypeLabel("README.md")).toBe("MD");
  });

  it("keeps matching ancestors and the active file while filtering", () => {
    const tree = buildChangedFileTree(files, "deep", "README.md");
    expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual([
      "directory:src",
      "file:README.md",
    ]);
    const src = tree[0];
    if (src?.kind === "directory") {
      expect(src.children[0]).toMatchObject({ kind: "directory", name: "deep" });
    }
  });

  it("preserves valid selection and falls back by display order", () => {
    expect(resolveChangedFileSelection(files, "src/a.ts")).toBe("src/a.ts");
    expect(resolveChangedFileSelection(files, "missing.ts")).toBe("src/deep/b.ts");
    expect(resolveChangedFileSelection([], "missing.ts")).toBeNull();
  });
});
