import { test, expect } from "bun:test";
import { renderMarkdown } from "./markdown.ts";

// ansi codes are disabled when stdout isn't a TTY (the test env), so these
// assertions check the structural transforms, not the color escapes.

test("headings drop the leading hashes", () => {
  expect(renderMarkdown("# Title")).toBe("Title");
  expect(renderMarkdown("### Sub")).toBe("Sub");
});

test("bullet lists become • markers, preserving indent", () => {
  expect(renderMarkdown("- one")).toBe("• one");
  expect(renderMarkdown("  * two")).toBe("  • two");
});

test("inline code, bold, and italic strip their markers", () => {
  expect(renderMarkdown("use `x` now")).toBe("use x now");
  expect(renderMarkdown("**b** and *i*")).toBe("b and i");
  expect(renderMarkdown("__b__ and _i_")).toBe("b and i");
});

test("fenced code blocks drop the fences and keep the body", () => {
  const out = renderMarkdown("```ts\nconst a = 1;\n```");
  expect(out).toContain("const a = 1;");
  expect(out).not.toContain("```");
});

test("plain prose is unchanged", () => {
  expect(renderMarkdown("just a sentence.")).toBe("just a sentence.");
});
