import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMentions, expandMentions } from "./mentions.ts";

test("parseMentions extracts @tokens and trims trailing punctuation", () => {
  expect(parseMentions("look at @src/a.ts and @b.md.")).toEqual(["src/a.ts", "b.md"]);
  expect(parseMentions("email me@example.com is not a leading mention")).toEqual([]);
  expect(parseMentions("@only")).toEqual(["only"]);
});

test("expandMentions injects text-file contents as a fenced block", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-mention-"));
  await Bun.write(join(cwd, "note.txt"), "hello from file");
  const r = await expandMentions("summarize @note.txt please", cwd);
  expect(r.text).toContain("Referenced files:");
  expect(r.text).toContain("--- note.txt ---");
  expect(r.text).toContain("hello from file");
  expect(r.images).toHaveLength(0);
});

test("unresolvable mentions pass through untouched", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-mention-"));
  const r = await expandMentions("what about @nope/missing.ts?", cwd);
  expect(r.text).toBe("what about @nope/missing.ts?");
  expect(r.images).toHaveLength(0);
});

test("image mentions become attachments, not text blocks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-mention-"));
  // A 1x1 PNG header is enough; we only check it's read as bytes.
  await Bun.write(join(cwd, "pic.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const r = await expandMentions("describe @pic.png", cwd);
  expect(r.images).toHaveLength(1);
  expect(r.images[0]?.mediaType).toBe("image/png");
  expect(r.images[0]?.data.length).toBeGreaterThan(0);
  // No text block appended for an image.
  expect(r.text).toBe("describe @pic.png");
});

test("duplicate mentions are de-duplicated", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-mention-"));
  await Bun.write(join(cwd, "a.txt"), "x");
  const r = await expandMentions("@a.txt @a.txt", cwd);
  const occurrences = r.text.split("--- a.txt ---").length - 1;
  expect(occurrences).toBe(1);
});

test("a directory mention expands to a capped listing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-mention-dir-"));
  await Bun.write(join(cwd, "src", "a.ts"), "a");
  await Bun.write(join(cwd, "src", "b.ts"), "b");
  const r = await expandMentions("look at @src", cwd);
  expect(r.text).toContain("(directory)");
  expect(r.text).toContain("a.ts");
  expect(r.text).toContain("b.ts");
});

test("text-file truncation is byte-accurate for multibyte content", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-mention-cjk-"));
  // 40k '中' chars = 120k UTF-8 bytes (> 64k cap) but 40k UTF-16 code units.
  await Bun.write(join(cwd, "big.txt"), "中".repeat(40_000));
  const r = await expandMentions("@big.txt", cwd);
  expect(r.notices.some((n) => n.includes("truncated"))).toBe(true);
  // The injected block honors the byte budget (was ~3x over with String.slice).
  expect(Buffer.byteLength(r.text, "utf8")).toBeLessThan(64_000 + 2_000);
});
