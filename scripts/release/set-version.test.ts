import { test, expect } from "bun:test";
import {
  extractChangelogSection,
  parseVersion,
  promoteChangelog,
  rewritePackageJsonVersion,
  rewriteVersionFile,
  todayUTC,
} from "./set-version.ts";

test("parseVersion strips a leading v and validates semver", () => {
  expect(parseVersion("v0.3.0")).toBe("0.3.0");
  expect(parseVersion("0.3.0")).toBe("0.3.0");
  expect(parseVersion("1.2.3-rc.1")).toBe("1.2.3-rc.1");
  expect(parseVersion("  v2.0.0-beta+build.5 ")).toBe("2.0.0-beta+build.5");
  expect(() => parseVersion("0.3")).toThrow();
  expect(() => parseVersion("latest")).toThrow();
  expect(() => parseVersion("v1.2.x")).toThrow();
});

test("rewriteVersionFile swaps only the VERSION literal", () => {
  const src = `// doc\nexport const VERSION = "0.0.0-dev";\n`;
  expect(rewriteVersionFile(src, "0.3.0")).toBe(`// doc\nexport const VERSION = "0.3.0";\n`);
  expect(() => rewriteVersionFile("no version here", "0.3.0")).toThrow();
});

test("rewritePackageJsonVersion edits the top-level version field only", () => {
  const pkg = `{\n  "name": "vibe-codr",\n  "version": "0.0.0",\n  "dependencies": { "ai": "^5.0.0" }\n}`;
  const out = rewritePackageJsonVersion(pkg, "0.3.0");
  expect(JSON.parse(out).version).toBe("0.3.0");
  // Dependency ranges are untouched.
  expect(JSON.parse(out).dependencies.ai).toBe("^5.0.0");
  expect(() => rewritePackageJsonVersion("{}", "0.3.0")).toThrow();
});

test("promoteChangelog renames Unreleased and leaves a fresh Unreleased on top", () => {
  const cl = `# Changelog\n\n## Unreleased\n\n- did a thing\n\n## 0.1.0 — 2026-01-01\n\n- first\n`;
  const out = promoteChangelog(cl, "0.2.0", "2026-07-02");
  expect(out).toContain("## Unreleased\n\n## 0.2.0 — 2026-07-02");
  expect(out).toContain("- did a thing");
  // The old released section is preserved.
  expect(out).toContain("## 0.1.0 — 2026-01-01");
  // Exactly one Unreleased heading remains.
  expect(out.match(/^## Unreleased/gm)?.length).toBe(1);
});

test("promoteChangelog is a no-op without an Unreleased section", () => {
  const cl = `# Changelog\n\n## 0.1.0 — 2026-01-01\n\n- first\n`;
  expect(promoteChangelog(cl, "0.2.0", "2026-07-02")).toBe(cl);
});

test("extractChangelogSection pulls one version's body", () => {
  const cl = `# Changelog\n\n## 0.2.0 — 2026-07-02\n\n- added X\n- fixed Y\n\n## 0.1.0 — 2026-01-01\n\n- first\n`;
  expect(extractChangelogSection(cl, "0.2.0")).toBe("- added X\n- fixed Y");
  expect(extractChangelogSection(cl, "0.1.0")).toBe("- first");
  expect(extractChangelogSection(cl, "9.9.9")).toBe("");
});

test("todayUTC formats YYYY-MM-DD in UTC", () => {
  expect(todayUTC(new Date("2026-07-02T23:59:59.000Z"))).toBe("2026-07-02");
});
