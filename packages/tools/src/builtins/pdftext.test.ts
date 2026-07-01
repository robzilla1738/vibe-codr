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
