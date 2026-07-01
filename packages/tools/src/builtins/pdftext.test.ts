import { test, expect } from "bun:test";
import { join } from "node:path";
import { extractPdfText } from "./pdftext.ts";

test("extracts text from a FlateDecode-compressed PDF", async () => {
  const bytes = await Bun.file(join(import.meta.dir, "__fixtures__", "sample.pdf")).arrayBuffer();
  const pdf = extractPdfText(Buffer.from(bytes));
  expect(pdf).not.toBeNull();
  expect(pdf!.pages).toBe(1);
  expect(pdf!.text).toContain("Hello PDF world");
  expect(pdf!.text).toContain("vibe-codr extraction test");
});

test("returns null for a non-PDF buffer", () => {
  expect(extractPdfText(Buffer.from("<html>not a pdf</html>", "latin1"))).toBeNull();
});

test("returns null when there's no extractable text (too little printable body)", () => {
  // A valid PDF header but no text content stream → nothing to extract.
  expect(extractPdfText(Buffer.from("%PDF-1.4\n%%EOF", "latin1"))).toBeNull();
});

test("a deflate-bomb FlateDecode stream is skipped (capped inflate), not extracted or OOM'd", async () => {
  const zlib = await import("node:zlib");
  // A stream that BEGINS with a valid text op but inflates past the 32MB cap: with
  // the cap it's skipped (→ null); without it, it would inflate ~33MB and extract.
  const content = Buffer.concat([
    Buffer.from("BT (deflate bomb) Tj ET\n", "latin1"),
    Buffer.alloc(33 * 1024 * 1024, 0x20),
  ]);
  const bomb = zlib.deflateSync(content);
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.4\n<< /Filter /FlateDecode >>\nstream\n", "latin1"),
    bomb,
    Buffer.from("\nendstream\n%%EOF", "latin1"),
  ]);
  const start = Date.now();
  const result = extractPdfText(pdf);
  expect(result).toBeNull(); // oversized stream skipped → no extractable text
  expect(Date.now() - start).toBeLessThan(3000);
});
