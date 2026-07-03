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

test("a binary file mention is skipped, not injected as mojibake text", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-mention-"));
  // A non-image binary (e.g. a .bin/.pdf) with NUL bytes.
  await Bun.write(join(cwd, "blob.bin"), new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x00, 0x7f]));
  const r = await expandMentions("look at @blob.bin", cwd);
  // Not injected as a text block…
  expect(r.text).toBe("look at @blob.bin");
  // …and a notice explains why.
  expect(r.notices.some((n) => n.includes("blob.bin") && n.includes("binary"))).toBe(true);
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

test("an over-cap text file reads only its head (bounded read, not whole-file slurp)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-mention-big-"));
  // 300KB: a HEAD marker, filler past the 64k cap, then a TAIL marker that must
  // be dropped (proving the injected content is the bounded head, not the tail).
  const body = `HEAD_MARKER\n${"x".repeat(300_000)}\nTAIL_MARKER`;
  await Bun.write(join(cwd, "big.log"), body);
  const r = await expandMentions("@big.log", cwd);
  expect(r.text).toContain("HEAD_MARKER");
  expect(r.text).not.toContain("TAIL_MARKER");
  expect(r.notices.some((n) => n.includes("truncated"))).toBe(true);
  expect(Buffer.byteLength(r.text, "utf8")).toBeLessThan(64_000 + 2_000);
});

test("an over-cap image is skipped by the bounded read, not slurped whole", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-mention-bigimg-"));
  // A 6MB "png" (> the 5MB image cap): a valid PNG header + filler. The bounded
  // read (cap+1) must reject it with a notice rather than attach a partial image.
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await Bun.write(join(cwd, "big.png"), Buffer.concat([header, Buffer.alloc(6 * 1024 * 1024)]));
  const r = await expandMentions("@big.png", cwd);
  expect(r.images.length).toBe(0);
  expect(r.notices.some((n) => /big\.png.*(exceeds|skipped|max)/i.test(n))).toBe(true);
});
