import { describe, expect, it } from "vitest";
import { classifyDiffLine, isUnifiedDiff, parseUnifiedDiff } from "./diff-view";

describe("classifyDiffLine", () => {
  it("does not treat file headers as add/del", () => {
    expect(classifyDiffLine("--- a/src/a.ts")).toBe("header");
    expect(classifyDiffLine("+++ b/src/a.ts")).toBe("header");
    expect(classifyDiffLine("diff --git a/x b/x")).toBe("header");
    expect(classifyDiffLine("index abc..def 100644")).toBe("header");
  });

  it("classifies body lines", () => {
    expect(classifyDiffLine("@@ -1,3 +1,4 @@")).toBe("hunk");
    expect(classifyDiffLine("+added")).toBe("add");
    expect(classifyDiffLine("-removed")).toBe("del");
    expect(classifyDiffLine(" context")).toBe("ctx");
    expect(classifyDiffLine("\\ No newline at end of file")).toBe("meta");
  });
});

describe("parseUnifiedDiff", () => {
  it("rejects current file contents that were mislabeled as a diff", () => {
    const contents = 'import type { Metadata } from "next";\nexport default function Layout() {}';
    expect(isUnifiedDiff(contents)).toBe(false);
    expect(parseUnifiedDiff(contents)).toEqual([]);
  });

  const sample = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line one
-line two
+line two edited
 line three
+line four
`;

  it("assigns old/new line numbers through a hunk", () => {
    const lines = parseUnifiedDiff(sample);
    expect(lines[0]?.kind).toBe("header");
    expect(lines.find((l) => l.kind === "hunk")?.text).toContain("@@");

    const body = lines.filter((l) => l.kind === "add" || l.kind === "del" || l.kind === "ctx");
    //   1,1 context " line one"
    //   2,- del "line two"
    //   -,2 add "line two edited"
    //   3,3 context " line three"
    //   -,4 add "line four"
    expect(body).toEqual([
      expect.objectContaining({ kind: "ctx", oldNo: 1, newNo: 1 }),
      expect.objectContaining({ kind: "del", oldNo: 2, newNo: null }),
      expect.objectContaining({ kind: "add", oldNo: null, newNo: 2 }),
      expect.objectContaining({ kind: "ctx", oldNo: 3, newNo: 3 }),
      expect.objectContaining({ kind: "add", oldNo: null, newNo: 4 }),
    ]);
  });

  it("returns empty for missing/empty diff", () => {
    expect(parseUnifiedDiff(undefined)).toEqual([]);
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("renders the engine's headerless compact diff format", () => {
    const lines = parseUnifiedDiff(" context\n-old\n+new\n…\n+tail");
    expect(lines.filter((line) => line.kind === "del")).toEqual([
      expect.objectContaining({ oldNo: 2, newNo: null }),
    ]);
    expect(lines.filter((line) => line.kind === "add")).toEqual([
      expect.objectContaining({ oldNo: null, newNo: 2 }),
      expect.objectContaining({ oldNo: null, newNo: 3 }),
    ]);
  });

  it("keeps bounded compact diffs with reducer omission markers reviewable", () => {
    for (const marker of [
      "… 27 earlier diff lines omitted …",
      "… 4096 earlier diff characters omitted …",
    ]) {
      const diff = `${marker}\n context\n-old\n+new`;
      expect(isUnifiedDiff(diff)).toBe(true);
      expect(parseUnifiedDiff(diff)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "meta", text: marker }),
          expect.objectContaining({ kind: "del", text: "-old" }),
          expect.objectContaining({ kind: "add", text: "+new" }),
        ]),
      );
    }
  });

  it("never paints +++ / --- as green/red body rows", () => {
    const lines = parseUnifiedDiff("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n");
    expect(lines.filter((l) => l.kind === "header")).toHaveLength(2);
    expect(lines.filter((l) => l.kind === "add")).toHaveLength(1);
    expect(lines.filter((l) => l.kind === "del")).toHaveLength(1);
  });
});
