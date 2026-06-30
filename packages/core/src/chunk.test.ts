import { test, expect } from "bun:test";
import { chunkMarkdown, sha256 } from "./chunk.ts";

test("splits a markdown doc into one chunk per heading section", () => {
  const md = "# A\nalpha body\n\n# B\nbeta body\n\n## C\ngamma body";
  const chunks = chunkMarkdown("notes.md", md);
  expect(chunks).toHaveLength(3);
  expect(chunks.map((c) => c.heading)).toEqual(["A", "B", "C"]);
  expect(chunks[0]!.text).toContain("alpha body");
  expect(chunks.every((c) => c.id.startsWith("notes.md::"))).toBe(true);
});

test("ids are content-addressed and stable across edits to OTHER sections", () => {
  const before = chunkMarkdown("m.md", "# A\nkeep me\n\n# B\nold body");
  const after = chunkMarkdown("m.md", "# A\nkeep me\n\n# B\nnew body");
  // Section A is unchanged → same id; section B changed → new id.
  const aBefore = before.find((c) => c.heading === "A")!;
  const aAfter = after.find((c) => c.heading === "A")!;
  expect(aAfter.id).toBe(aBefore.id);
  const bBefore = before.find((c) => c.heading === "B")!;
  const bAfter = after.find((c) => c.heading === "B")!;
  expect(bAfter.id).not.toBe(bBefore.id);
});

test("hash matches sha256 of the chunk text", () => {
  const [c] = chunkMarkdown("x.md", "# H\nhello world");
  expect(c!.hash).toBe(sha256(c!.text));
});

test("an oversized section is split into multiple bounded chunks", () => {
  const big = `# Big\n${"lorem ipsum ".repeat(1_000)}`; // ~12KB
  const chunks = chunkMarkdown("big.md", big);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(2_000);
});

test("byte-identical sections within a file collapse to one chunk", () => {
  // Same heading AND body → identical chunk text → same content hash → deduped.
  const chunks = chunkMarkdown("dup.md", "# Note\nsame body\n\n# Note\nsame body");
  expect(chunks).toHaveLength(1);
});

test("content with no headings still yields a chunk", () => {
  const chunks = chunkMarkdown("plain.md", "just some prose\nwith two lines");
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.text).toContain("just some prose");
});
