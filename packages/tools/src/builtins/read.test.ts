import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { readTool } from "./read.ts";

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

test("returns line-numbered content with optional offset/limit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-read-"));
  await Bun.write(join(cwd, "f.txt"), "a\nb\nc\nd");

  const full = await readTool.execute({ path: "f.txt" }, ctx(cwd));
  expect(full.output).toBe("1\ta\n2\tb\n3\tc\n4\td");

  const page = await readTool.execute({ path: "f.txt", offset: 1, limit: 2 }, ctx(cwd));
  expect(page.output).toBe("2\tb\n3\tc");
});

test("reports a missing file as an error", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-read-miss-"));
  const r = await readTool.execute({ path: "nope.txt" }, ctx(cwd));
  expect(r.isError).toBe(true);
  expect(r.output).toContain("File not found");
});

test("an empty file reads as a distinct marker", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-read-empty-"));
  await Bun.write(join(cwd, "e.txt"), "");
  const r = await readTool.execute({ path: "e.txt" }, ctx(cwd));
  expect(r.output).toBe("(empty file)");
  expect(r.isError).toBeUndefined();
});

test("refuses a binary file instead of dumping garbage", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-read-bin-"));
  // A PNG header carries NUL bytes — the binary sniff should catch it.
  await Bun.write(join(cwd, "img.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]));
  const r = await readTool.execute({ path: "img.png" }, ctx(cwd));
  expect(r.isError).toBe(true);
  expect(r.output).toContain("binary file");
});

test("caps a single huge line with a truncation marker", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-read-cap-"));
  await Bun.write(join(cwd, "min.js"), "x".repeat(250_000));
  const r = await readTool.execute({ path: "min.js" }, ctx(cwd));
  expect(r.isError).toBeUndefined();
  expect((r.output as string).length).toBeLessThan(101_000);
  expect(r.output).toContain("truncated at 100000 chars");
});

test("flags an offset past the end of a non-empty file", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-read-off-"));
  await Bun.write(join(cwd, "f.txt"), "a\nb\nc");
  const r = await readTool.execute({ path: "f.txt", offset: 99 }, ctx(cwd));
  expect(r.isError).toBe(true);
  expect(r.output).toContain("past the end");
});
