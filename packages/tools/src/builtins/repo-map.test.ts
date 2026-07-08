import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@vibe/shared";
import { FreshnessRegistry } from "./freshness.ts";

const freshness = new FreshnessRegistry();
import {
  repoMapTool,
  extractSymbols,
  rankFiles,
  isCodeFile,
  parseImports,
  buildRepoMap,
  _resetRepoMapCache,
} from "./repo-map.ts";

beforeEach(() => _resetRepoMapCache());

function ctx(cwd: string): ToolContext {
  return { cwd, sessionId: "s", emit: () => {}, toolCallId: "t", abortSignal: new AbortController().signal, freshness };
}

test("extractSymbols pulls top-level TS declarations, skipping nested members", () => {
  const src = [
    "import { x } from './y';",
    "export function alpha() {",
    "  const inner = 1;", // nested → skipped
    "}",
    "export class Beta {",
    "  method() {}", // nested → skipped
    "}",
    "type Gamma = string;",
    "const notExported = 2;", // not a decl keyword / not exported → skipped
  ].join("\n");
  const symbols = extractSymbols(src, ".ts");
  expect(symbols).toContain("export function alpha()");
  expect(symbols).toContain("export class Beta");
  expect(symbols).toContain("type Gamma = string;");
  expect(symbols.some((s) => s.includes("inner"))).toBe(false);
  expect(symbols.some((s) => s.includes("method"))).toBe(false);
});

test("extractSymbols handles Python and Go", () => {
  expect(extractSymbols("def foo():\n    pass\nclass Bar:\n    pass", ".py")).toEqual(["def foo():", "class Bar:"]);
  expect(extractSymbols("func Handle() {}\ntype Server struct {", ".go")).toContain("func Handle()");
});

test("rankFiles puts entrypoints first and tests last", () => {
  const ranked = rankFiles(["src/util/helpers.ts", "src/index.ts", "src/util/helpers.test.ts", "main.go"]);
  expect(ranked[0]).toMatch(/index\.ts|main\.go/);
  expect(ranked.at(-1)).toBe("src/util/helpers.test.ts");
});

test("isCodeFile recognizes source extensions only", () => {
  expect(isCodeFile("a.ts")).toBe(true);
  expect(isCodeFile("a.py")).toBe(true);
  expect(isCodeFile("README.md")).toBe(false);
  expect(isCodeFile("data.json")).toBe(false);
});

test("parseImports finds relative JS/TS and Python imports, ignores packages", () => {
  const ts = parseImports(
    [
      "import { a } from './a.ts';",
      "import b from '../lib/b';",
      "const c = require('./c');",
      "const d = await import('./d');",
      "import { z } from 'zod';", // package — ignored
    ].join("\n"),
    ".ts",
  );
  expect(ts).toEqual(["./a.ts", "../lib/b", "./c", "./d"]);
  expect(parseImports("from .helpers import x\nimport os", ".py")).toEqual([".helpers"]);
});

test("import in-degree outranks the path heuristic: a deep but heavily-referenced file rises", () => {
  const inDegree = new Map([["src/deep/nested/core.ts", 8]]);
  const ranked = rankFiles(["src/shallow.ts", "src/deep/nested/core.ts"], inDegree);
  expect(ranked[0]).toBe("src/deep/nested/core.ts");
});

test("buildRepoMap ranks referenced files up and serves unchanged files from cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-repomap-graph-"));
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  // hub.ts is imported by two files → should outrank its siblings.
  writeFileSync(join(dir, "src", "lib", "hub.ts"), "export function hub() {}\n");
  writeFileSync(join(dir, "src", "a.ts"), "import { hub } from './lib/hub.ts';\nexport function a() {}\n");
  writeFileSync(join(dir, "src", "b.ts"), "import { hub } from './lib/hub';\nexport function b() {}\n");

  const first = await buildRepoMap(dir);
  const hubIdx = first.text.indexOf("src/lib/hub.ts");
  expect(hubIdx).toBeGreaterThanOrEqual(0);
  expect(hubIdx).toBeLessThan(first.text.indexOf("src/a.ts"));

  // Mutate a file (bump mtime) and rebuild: the changed file re-extracts, the map updates.
  writeFileSync(join(dir, "src", "a.ts"), "export function aChanged() {}\n");
  const future = Date.now() / 1000 + 5;
  utimesSync(join(dir, "src", "a.ts"), future, future);
  const second = await buildRepoMap(dir);
  expect(second.text).toContain("aChanged");
});

test("buildRepoMap respects the char budget with an explicit truncated flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-repomap-budget-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(dir, "src", `f${i}.ts`), `export function fn${i}() {}\nexport const V${i} = ${i};\n`);
  }
  const res = await buildRepoMap(dir, { charBudget: 200 });
  expect(res.truncated).toBe(true);
  expect(res.text.length).toBeLessThanOrEqual(220);
});

test("buildRepoMap caps the number of files it READS, not just the count it renders", async () => {
  // On a huge repo, reading every tracked file to build the import graph stalls
  // bootstrap. With a read cap, only the top-ranked candidates are parsed at all —
  // a low-ranked file's symbols must be ABSENT even when the render budget/maxFiles
  // are generous (proving it was never read, not merely trimmed from the output).
  const dir = mkdtempSync(join(tmpdir(), "vibe-repomap-readcap-"));
  mkdirSync(join(dir, "deep", "nested"), { recursive: true });
  writeFileSync(join(dir, "index.ts"), "export function mainEntry() {}\n"); // ranks first
  writeFileSync(join(dir, "alpha.ts"), "export function alphaFn() {}\n"); // shallow → high
  writeFileSync(join(dir, "zeta.ts"), "export function zetaFn() {}\n"); // shallow → high
  writeFileSync(join(dir, "deep", "nested", "thing.test.ts"), "export function deepThing() {}\n"); // tests rank last

  // maxFiles/charBudget are generous; readLimit is the only thing trimming.
  const res = await buildRepoMap(dir, { readLimit: 2, maxFiles: 100, charBudget: 100_000 });
  expect(res.text).toContain("mainEntry"); // index.ts is read (top-ranked)
  expect(res.text).not.toContain("deepThing"); // the test file is never read
  expect(res.truncated).toBe(true); // more files exist than were read
});

test("repo_map produces a declaration map for a directory (no git)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-repomap-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export function main() {}\nexport const VERSION = '1';\n");
  writeFileSync(join(dir, "src", "util.ts"), "export class Helper {}\n");
  writeFileSync(join(dir, "README.md"), "# not code");

  const res = await repoMapTool.execute({}, ctx(dir));
  const out = String(res.output);
  expect(out).toContain("src/index.ts");
  expect(out).toContain("export function main()");
  expect(out).toContain("src/util.ts");
  expect(out).toContain("export class Helper");
  expect(out).not.toContain("README.md"); // non-code excluded
});

test("buildRepoMap skips a file larger than the per-file byte cap (no whole-file slurp)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-repomap-bigfile-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  // A small real source file whose symbol MUST appear.
  writeFileSync(join(dir, "src", "small.ts"), "export function realSymbol() {}\n");
  // A >512KB tracked .ts (e.g. a committed bundle/generated file) with a unique
  // symbol that must NOT be extracted — the file is skipped, not slurped+regexed.
  const big = `export function hugeGeneratedSymbol() {}\n${"// filler\n".repeat(60_000)}`;
  expect(big.length).toBeGreaterThan(512 * 1024);
  writeFileSync(join(dir, "src", "generated.ts"), big);

  const res = await buildRepoMap(dir);
  expect(res.text).toContain("realSymbol");
  expect(res.text).not.toContain("hugeGeneratedSymbol"); // over-cap file never parsed
});
