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

  // offset is 1-based: offset:2 begins at the line rendered "2".
  const page = await readTool.execute({ path: "f.txt", offset: 2, limit: 2 }, ctx(cwd));
  expect(page.output).toBe("2\tb\n3\tc");
});

test("offset is 1-based: offset:1 equals omitting offset", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-read-1based-"));
  await Bun.write(join(cwd, "f.txt"), "a\nb\nc\nd");
  const full = await readTool.execute({ path: "f.txt" }, ctx(cwd));
  const fromOne = await readTool.execute({ path: "f.txt", offset: 1 }, ctx(cwd));
  expect(fromOne.output).toBe(full.output);
  expect(fromOne.output).toBe("1\ta\n2\tb\n3\tc\n4\td");
});

test("offset:2 begins at the displayed line 2", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-read-off2-"));
  await Bun.write(join(cwd, "f.txt"), "a\nb\nc\nd");
  const r = await readTool.execute({ path: "f.txt", offset: 2 }, ctx(cwd));
  expect(r.output).toBe("2\tb\n3\tc\n4\td");
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

test("detects a binary file whose first NUL is past the 4096-byte head sniff", async () => {
  // The head sniff only reads the first 4096 bytes; a file whose NUL appears
  // deeper used to be fully slurped by `await file.text()` and dumped as mojibake.
  // The streaming read now sniffs the bytes it actually reads and refuses.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-read-binmid-"));
  const head = new Uint8Array(5000).fill(0x61); // 5000 'a' — no NUL in the head
  const withNul = new Uint8Array([...head, 0x00, 0x62, 0x63]);
  await Bun.write(join(cwd, "mid.bin"), withNul);
  const r = await readTool.execute({ path: "mid.bin" }, ctx(cwd));
  expect(r.isError).toBe(true);
  expect(r.output).toContain("binary file");
});

test("offset/limit read only the requested window of a large file (no full slurp)", async () => {
  // A huge tail after the requested window must never be materialized. The window
  // is returned intact with correct 1-based line numbers, and none of the tail leaks.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-read-window-"));
  const tail = "Z".repeat(40_000_000); // 40MB on line 4 — must not be loaded
  await Bun.write(join(cwd, "big.log"), `L1\nL2\nL3\n${tail}`);
  const r = await readTool.execute({ path: "big.log", offset: 1, limit: 3 }, ctx(cwd));
  expect(r.isError).toBeUndefined();
  expect(r.output).toBe("1\tL1\n2\tL2\n3\tL3");
  expect(String(r.output)).not.toContain("Z");
});

test("flags an offset past the end of a non-empty file", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-read-off-"));
  await Bun.write(join(cwd, "f.txt"), "a\nb\nc");
  const r = await readTool.execute({ path: "f.txt", offset: 99 }, ctx(cwd));
  expect(r.isError).toBe(true);
  expect(r.output).toContain("past the end");
  // The error reports the 1-based offset the model supplied, not a 0-based index.
  expect(r.output).toContain("offset 99 is past the end");
});
