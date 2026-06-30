import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@vibe/shared";
import { repoMapTool, extractSymbols, rankFiles, isCodeFile } from "./repo-map.ts";

function ctx(cwd: string): ToolContext {
  return { cwd, sessionId: "s", emit: () => {}, toolCallId: "t", abortSignal: new AbortController().signal };
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
