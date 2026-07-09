import { test, expect } from "bun:test";
import {
  fuzzyPathScore,
  rankPaths,
  atMentionState,
  applyAtMention,
  listProjectFiles,
} from "./file-fuzzy.ts";

test("fuzzyPathScore prefers basename prefix over deep path substring", () => {
  expect(fuzzyPathScore("packages/tui/src/app.tsx", "app")).toBeGreaterThan(
    fuzzyPathScore("packages/core/src/append.ts", "app"),
  );
  expect(fuzzyPathScore("src/app.tsx", "app.tsx")).toBeGreaterThan(
    fuzzyPathScore("src/other.tsx", "app"),
  );
  expect(fuzzyPathScore("readme.md", "zzz")).toBe(0);
});

test("rankPaths returns top matches capped", () => {
  const paths = [
    "packages/tui/src/app.tsx",
    "packages/core/src/engine.ts",
    "packages/tui/src/modes.ts",
    "README.md",
  ];
  const ranked = rankPaths(paths, "app", 2);
  expect(ranked.length).toBeGreaterThanOrEqual(1);
  expect(ranked.length).toBeLessThanOrEqual(2);
  expect(ranked[0]).toContain("app.tsx");
  // Cap respected even when more candidates match.
  expect(rankPaths(paths, "", 2)).toHaveLength(2);
});

test("atMentionState detects trailing @query and ignores slash drafts", () => {
  expect(atMentionState("look at @src/ap")).toEqual({ query: "src/ap", atIndex: 8 });
  expect(atMentionState("@")).toEqual({ query: "", atIndex: 0 });
  expect(atMentionState("hello @")).toEqual({ query: "", atIndex: 6 });
  expect(atMentionState("/model @x")).toBeNull();
  expect(atMentionState("plain text")).toBeNull();
  expect(atMentionState("email me@host.com more")).toBeNull(); // no space before second @ mid-token
});

test("atMentionState only triggers when @ is token-initial", () => {
  // `foo@bar` is not a mention (no whitespace before @).
  expect(atMentionState("foo@bar")).toBeNull();
  expect(atMentionState("see @bar")).toEqual({ query: "bar", atIndex: 4 });
});

test("applyAtMention replaces the trailing mention", () => {
  expect(applyAtMention("see @ap", 4, "src/app.tsx", true)).toBe("see @src/app.tsx ");
  expect(applyAtMention("see @ap", 4, "src/app.tsx", false)).toBe("see @src/app.tsx");
  expect(applyAtMention("@", 0, "README.md", true)).toBe("@README.md ");
});

test("listProjectFiles walks with caps and skips heavy dirs", () => {
  const tree: Record<string, { name: string; isDirectory: boolean }[]> = {
    "/root": [
      { name: "src", isDirectory: true },
      { name: "node_modules", isDirectory: true },
      { name: "README.md", isDirectory: false },
      { name: ".git", isDirectory: true },
    ],
    "/root/src": [
      { name: "a.ts", isDirectory: false },
      { name: "b.ts", isDirectory: false },
    ],
    "/root/node_modules": [{ name: "pkg", isDirectory: true }],
  };
  const files = listProjectFiles("/root", {
    maxFiles: 100,
    maxDepth: 4,
    readdir: (dir) => tree[dir] ?? [],
  });
  expect(files).toContain("README.md");
  expect(files).toContain("src/a.ts");
  expect(files).toContain("src/b.ts");
  expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  expect(files.some((f) => f.includes(".git"))).toBe(false);
});
