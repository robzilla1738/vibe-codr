import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { grepTool, builtinGrep, readCappedLines, _resetRipgrepTypeCache } from "./grep.ts";

beforeEach(() => _resetRipgrepTypeCache());

/** Run a git command in `cwd`, silently. */
function git(cwd: string, ...args: string[]): void {
  Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
}

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

// ── New parity params: ignoreCase / context / fileType ─────────────────────────
// Each is asserted on BOTH the ripgrep path (grepTool.execute — uses rg when
// installed) and the dependency-free fallback (builtinGrep directly, always).

test("ignoreCase matches across case on both paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-grep-ic-"));
  await Bun.write(join(dir, "a.txt"), "alpha\nNEEDLE here\nbeta\n");

  // rg (or fallback) path via execute.
  const insensitive = await grepTool.execute({ pattern: "needle", ignoreCase: true }, ctx(dir));
  expect(insensitive.output).toContain("NEEDLE here");
  const sensitive = await grepTool.execute({ pattern: "needle" }, ctx(dir));
  expect(sensitive.output).toBe("(no matches)");

  // Fallback path directly.
  const fb = await builtinGrep({ pattern: "needle", ignoreCase: true }, ctx(dir));
  expect(fb.output).toContain("NEEDLE here");
  expect((await builtinGrep({ pattern: "needle" }, ctx(dir))).output).toBe("(no matches)");
});

test("ignoreCase works for a true regex on the fallback path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-grep-icrx-"));
  await Bun.write(join(dir, "a.txt"), "Foobar\n");
  // `foo.*` is a real regex (metachars) → exercises the RegExp `i` flag branch.
  const r = await builtinGrep({ pattern: "foo.*", ignoreCase: true }, ctx(dir));
  expect(r.output).toContain("a.txt:1:Foobar");
});

test("context includes surrounding lines on both paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-grep-ctx-"));
  await Bun.write(join(dir, "a.txt"), "one\ntwo\nMATCH\nfour\nfive\n");

  const viaExec = await grepTool.execute({ pattern: "MATCH", context: 1 }, ctx(dir));
  expect(viaExec.output).toContain("two");
  expect(viaExec.output).toContain("four");
  expect(viaExec.output).not.toContain("one");

  const fb = await builtinGrep({ pattern: "MATCH", context: 1 }, ctx(dir));
  // The match keeps the `:` separator; context lines use `-` (ripgrep parity).
  expect(fb.output).toContain("a.txt:3:MATCH");
  expect(fb.output).toContain("a.txt-2-two");
  expect(fb.output).toContain("a.txt-4-four");
  expect(fb.output).not.toContain("one");
});

test("context=0 and out-of-range values are clamped (no context) on the fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-grep-ctx0-"));
  await Bun.write(join(dir, "a.txt"), "one\nMATCH\nthree\n");
  const r = await builtinGrep({ pattern: "MATCH", context: 0 }, ctx(dir));
  expect(r.output).toBe("a.txt:2:MATCH");
});

test("fileType restricts to the given extension on both paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-grep-ft-"));
  await Bun.write(join(dir, "a.ts"), "needle\n");
  await Bun.write(join(dir, "b.py"), "needle\n");

  const viaExec = await grepTool.execute({ pattern: "needle", fileType: "ts" }, ctx(dir));
  expect(viaExec.output).toContain("a.ts");
  expect(viaExec.output).not.toContain("b.py");

  const fb = await builtinGrep({ pattern: "needle", fileType: "ts" }, ctx(dir));
  expect(fb.output).toContain("a.ts:1:needle");
  expect(fb.output).not.toContain("b.py");
});

test("fileType with an rg-unknown extension still filters via a glob fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-grep-ftx-"));
  await Bun.write(join(dir, "a.xyzzy"), "needle\n");
  await Bun.write(join(dir, "b.txt"), "needle\n");
  // "xyzzy" is not a known ripgrep --type, so rg must fall back to `*.xyzzy`.
  const r = await grepTool.execute({ pattern: "needle", fileType: "xyzzy" }, ctx(dir));
  expect(r.output).toContain("a.xyzzy");
  expect(r.output).not.toContain("b.txt");
});

test("fallback matches untracked-but-not-ignored files (ripgrep parity), skips ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-grep-git-"));
  await Bun.write(join(dir, "tracked.ts"), "needle in tracked\n");
  await Bun.write(join(dir, "untracked.ts"), "needle in untracked\n");
  await Bun.write(join(dir, "ignored.ts"), "needle in ignored\n");
  await Bun.write(join(dir, ".gitignore"), "ignored.ts\n");
  git(dir, "init");
  git(dir, "add", "tracked.ts", ".gitignore");

  const r = await builtinGrep({ pattern: "needle" }, ctx(dir));
  expect(r.output).toContain("tracked.ts:1:needle in tracked");
  // A just-written, not-yet-added file IS searched now — ripgrep would match it,
  // so the fallback must too (else the model wrongly concludes a symbol is absent).
  expect(r.output).toContain("untracked.ts:1:needle in untracked");
  // …but .gitignore is still honored (rg parity): an ignored file is NOT scanned.
  expect(r.output).not.toContain("in ignored");
});

test("readCappedLines caps DURING streaming — it cancels the source instead of draining it", async () => {
  // The ripgrep path must not buffer all stdout before slicing to 500: a near-
  // universal pattern streams hundreds of MB. This reader stops at LIMIT+1 lines
  // and cancels the stream, so a source that would produce far more is never drained.
  let produced = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= 100_000) {
        controller.close();
        return;
      }
      produced++;
      controller.enqueue(new TextEncoder().encode(`file.ts:${produced}:match\n`));
    },
    cancel() {
      cancelled = true;
    },
  });

  const { lines, truncated } = await readCappedLines(stream, 500);
  expect(truncated).toBe(true);
  expect(lines.length).toBe(501); // LIMIT + 1 (capResults then slices + marks)
  expect(cancelled).toBe(true); // the stream was cancelled, not exhausted
  expect(produced).toBeLessThan(1000); // stopped early — did NOT stream all 100k lines
});

test("readCappedLines returns every line (untruncated) when under the cap", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("a.ts:1:x\nb.ts:2:y\n"));
      controller.close();
    },
  });
  const { lines, truncated } = await readCappedLines(stream, 500);
  expect(truncated).toBe(false);
  expect(lines).toEqual(["a.ts:1:x", "b.ts:2:y"]);
});

test("VIBE_GREP_NO_RIPGREP forces the built-in fallback path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-grep-seam-"));
  await Bun.write(join(dir, "a.ts"), "needle here\n");
  const prev = process.env.VIBE_GREP_NO_RIPGREP;
  process.env.VIBE_GREP_NO_RIPGREP = "1";
  try {
    const r = await grepTool.execute({ pattern: "needle" }, ctx(dir));
    // The fallback emits the file:line:content shape (rg would too, but this
    // proves the seam routes without touching rg).
    expect(r.output).toContain("a.ts:1:needle here");
  } finally {
    if (prev === undefined) delete process.env.VIBE_GREP_NO_RIPGREP;
    else process.env.VIBE_GREP_NO_RIPGREP = prev;
  }
});
