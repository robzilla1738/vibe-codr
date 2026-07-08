import { test, expect } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { FreshnessRegistry } from "./freshness.ts";

const freshness = new FreshnessRegistry();
import { globTool } from "./glob.ts";

function ctx(cwd: string): ToolContext {
  const events: UIEvent[] = [];
  return {
    cwd,
    sessionId: "ses_test",
    abortSignal: new AbortController().signal,
    freshness,
    emit: (e) => events.push(e),
    toolCallId: "call_1",
  };
}

test("matches files by pattern and reports no matches distinctly", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-glob-"));
  await Promise.all([
    Bun.write(join(cwd, "a.ts"), ""),
    Bun.write(join(cwd, "b.ts"), ""),
    Bun.write(join(cwd, "c.md"), ""),
  ]);
  const hit = await globTool.execute({ pattern: "*.ts" }, ctx(cwd));
  expect((hit.output as string).split("\n").sort()).toEqual(["a.ts", "b.ts"]);

  const miss = await globTool.execute({ pattern: "*.rs" }, ctx(cwd));
  expect(miss.output).toBe("(no matches)");
});

test("appends a truncation marker past the 1000-match cap", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-glob-cap-"));
  await Promise.all(
    Array.from({ length: 1001 }, (_, i) => Bun.write(join(cwd, `f${i}.ts`), "")),
  );
  const r = await globTool.execute({ pattern: "*.ts" }, ctx(cwd));
  const lines = (r.output as string).split("\n");
  expect(lines.length).toBe(1001); // 1000 matches + the marker line
  expect(lines[lines.length - 1]).toContain("truncated at 1000 matches");
});

test("exactly 1000 matches is NOT flagged truncated (boundary)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-glob-exact-"));
  await Promise.all(
    Array.from({ length: 1000 }, (_, i) => Bun.write(join(cwd, `f${i}.ts`), "")),
  );
  const r = await globTool.execute({ pattern: "*.ts" }, ctx(cwd));
  const lines = (r.output as string).split("\n");
  expect(lines.length).toBe(1000); // all 1000, no spurious marker line
  expect(r.output as string).not.toContain("truncated");
});

test("results are sorted newest-first by mtime", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-glob-mtime-"));
  await Bun.write(join(cwd, "old.ts"), "");
  await Bun.write(join(cwd, "mid.ts"), "");
  await Bun.write(join(cwd, "new.ts"), "");
  // Assign explicit, well-separated mtimes so ordering is deterministic.
  utimesSync(join(cwd, "old.ts"), new Date(1_000_000), new Date(1_000_000));
  utimesSync(join(cwd, "mid.ts"), new Date(2_000_000), new Date(2_000_000));
  utimesSync(join(cwd, "new.ts"), new Date(3_000_000), new Date(3_000_000));
  const r = await globTool.execute({ pattern: "*.ts" }, ctx(cwd));
  expect((r.output as string).split("\n")).toEqual(["new.ts", "mid.ts", "old.ts"]);
});

test("excludes node_modules and .git by default", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-glob-excl-"));
  await Bun.write(join(cwd, "app.ts"), "");
  await Bun.write(join(cwd, "node_modules", "dep", "index.ts"), "");
  await Bun.write(join(cwd, ".git", "hooks", "pre-commit.ts"), "");
  const r = await globTool.execute({ pattern: "**/*.ts" }, ctx(cwd));
  const files = (r.output as string).split("\n");
  expect(files).toContain("app.ts");
  expect(files.some((f) => f.includes("node_modules/"))).toBe(false);
  expect(files.some((f) => f.startsWith(".git/"))).toBe(false);
});

import { resolveContainedDir } from "./glob.ts";

test("resolveContainedDir rejects workspace escape (BUG-051)", () => {
  const root = "/tmp/workspace";
  expect(resolveContainedDir(root, "src")).toBe("/tmp/workspace/src");
  expect(typeof resolveContainedDir(root, "../outside")).toBe("object");
  expect((resolveContainedDir(root, "../outside") as { error: string }).error).toMatch(/escapes/);
});
