import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { grepTool, builtinGrep } from "./grep.ts";

function ctx(cwd: string): ToolContext {
  const events: UIEvent[] = [];
  return {
    cwd,
    sessionId: "ses_test",
    abortSignal: new AbortController().signal,
    emit: (e) => events.push(e),
    toolCallId: "call_1",
  };
}

test("returns matching lines and reports no matches distinctly", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-grep-"));
  await Bun.write(join(cwd, "a.txt"), "alpha\nneedle here\nbeta\n");
  const hit = await grepTool.execute({ pattern: "needle" }, ctx(cwd));
  expect(hit.isError).toBeUndefined();
  expect(hit.output).toContain("needle here");

  const miss = await grepTool.execute({ pattern: "zzznope" }, ctx(cwd));
  expect(miss.output).toBe("(no matches)");
});

test("appends a truncation marker past the 500-match cap", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-grep-cap-"));
  const body = Array.from({ length: 600 }, (_, i) => `match ${i}`).join("\n");
  await Bun.write(join(cwd, "big.txt"), `${body}\n`);
  const r = await grepTool.execute({ pattern: "match" }, ctx(cwd));
  const lines = (r.output as string).split("\n");
  expect(lines.length).toBe(501); // 500 matches + the marker line
  expect(lines[lines.length - 1]).toContain("truncated at 500 matches");
});

// The built-in fallback (used when ripgrep isn't installed, e.g. some CI runners)
// must produce the same file:line:match shape and honor the cap.
test("built-in fallback grep matches lines, filters by glob, caps at 500", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-grep-js-"));
  await Bun.write(join(cwd, "a.ts"), "alpha\nneedle here\nbeta\n");
  await Bun.write(join(cwd, "b.md"), "needle in markdown\n");

  const hit = await builtinGrep({ pattern: "needle" }, ctx(cwd));
  expect(hit.isError).toBeUndefined();
  expect(hit.output).toContain("a.ts:2:needle here");
  expect(hit.output).toContain("b.md:1:needle in markdown");

  // glob filter restricts to *.ts.
  const tsOnly = await builtinGrep({ pattern: "needle", glob: "*.ts" }, ctx(cwd));
  expect(tsOnly.output).toContain("a.ts");
  expect(tsOnly.output).not.toContain("b.md");

  // no match → distinct sentinel.
  expect((await builtinGrep({ pattern: "zzznope" }, ctx(cwd))).output).toBe("(no matches)");

  // 500-match cap + marker.
  const big = mkdtempSync(join(tmpdir(), "vibe-grep-js-cap-"));
  await Bun.write(join(big, "big.txt"), `${Array.from({ length: 600 }, (_, i) => `match ${i}`).join("\n")}\n`);
  const capped = await builtinGrep({ pattern: "match" }, ctx(big));
  const lines = (capped.output as string).split("\n");
  expect(lines.length).toBe(501);
  expect(lines.at(-1)).toContain("truncated at 500 matches");
});

test("built-in fallback grep reports an invalid regex cleanly", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-grep-js-bad-"));
  await Bun.write(join(cwd, "a.txt"), "x");
  const res = await builtinGrep({ pattern: "(" }, ctx(cwd));
  expect(res.isError).toBe(true);
  expect(res.output).toContain("invalid regex");
});

test("builtinGrep skips pathologically long lines (no catastrophic-backtracking hang)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-grep-redos-"));
  // One 300k-char single line (like minified JS) + a normal matching line.
  await Bun.write(join(dir, "min.js"), `${"a".repeat(300_000)}\nreal needle here`);
  const start = Date.now();
  // A classic catastrophic-backtracking pattern; on the long line it would hang.
  const r = await builtinGrep({ pattern: "(a+)+$" }, ctx(dir));
  expect(Date.now() - start).toBeLessThan(2000); // the long line was skipped, no hang
  expect(r.isError).toBeUndefined();
});

test("builtinGrep still finds a literal match on a very long single line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-grep-long-"));
  // A 200k-char minified-style single line that contains a real symbol.
  await Bun.write(join(dir, "bundle.min.js"), `${"x".repeat(120_000)}getUserById${"y".repeat(120_000)}`);
  const r = await builtinGrep({ pattern: "getUserById" }, ctx(dir));
  // The literal symbol must be found (a substring scan, no ReDoS risk), not dropped
  // by the long-line guard (which only applies to true regex patterns).
  expect(String(r.output)).toContain("getUserById");
});
