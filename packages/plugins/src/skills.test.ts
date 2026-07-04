import { test, expect } from "bun:test";
import { parseSkillMarkdown, SkillRegistry } from "./skills.ts";

test("parses frontmatter and body from a LF document", () => {
  const { frontmatter, body } = parseSkillMarkdown(
    "---\nname: demo\ndescription: A demo skill\n---\nThe body here.\n",
  );
  expect(frontmatter.name).toBe("demo");
  expect(frontmatter.description).toBe("A demo skill");
  expect(body).toBe("The body here.");
});

test("recognizes frontmatter when the file uses CRLF line endings", () => {
  // A Windows-/editor-authored file: without CRLF normalization the LF-anchored
  // fence regex fails and ALL frontmatter is silently lost.
  const { frontmatter, body } = parseSkillMarkdown(
    "---\r\nname: win\r\ndescription: CRLF skill\r\n---\r\nBody line.\r\n",
  );
  expect(frontmatter.name).toBe("win");
  expect(frontmatter.description).toBe("CRLF skill");
  expect(body).toBe("Body line.");
});

test("a document with no frontmatter is all body", () => {
  const { frontmatter, body } = parseSkillMarkdown("Just text, no fence.");
  expect(frontmatter).toEqual({});
  expect(body).toBe("Just text, no fence.");
});

test("registry exposes whenToUse in progressive-disclosure descriptions", () => {
  const reg = new SkillRegistry();
  reg.register({
    name: "deploy",
    description: "Ship the app",
    whenToUse: "when the user asks to deploy",
    dir: "/x",
    load: async () => "body",
  });
  expect(reg.descriptions()).toEqual([
    "- deploy: Ship the app (use when: when the user asks to deploy)",
  ]);
});

test("folded block scalar (`>-`): description folds to one spaced string", () => {
  // The real-world shape that used to render as a literal ">-" in /skills:
  // Claude-style SKILL.md files routinely fold long descriptions.
  const { frontmatter } = parseSkillMarkdown(
    "---\nname: fold\ndescription: >-\n  Guides you through creating\n  well-structured skills.\n  Use when asked.\nlicense: MIT\n---\nBody.\n",
  );
  expect(frontmatter.description).toBe(
    "Guides you through creating well-structured skills. Use when asked.",
  );
  // The key AFTER the block is still parsed as its own entry.
  expect(frontmatter.license).toBe("MIT");
});

test("literal block scalar (`|`): lines keep their newlines", () => {
  const { frontmatter } = parseSkillMarkdown(
    "---\nname: lit\ndescription: |\n  line one\n  line two\n---\nBody.\n",
  );
  expect(frontmatter.description).toBe("line one\nline two");
});

test("folded scalar with an interior blank line keeps a paragraph break", () => {
  const { frontmatter } = parseSkillMarkdown("---\ndescription: >\n  para one\n\n  para two\n---\n");
  expect(frontmatter.description).toBe("para one\npara two");
});

test("indented continuation lines never become bogus keys", () => {
  // "Use when: foo" inside a folded block contains a colon — the old parser
  // would have treated a same-column line as a `key: value` entry.
  const { frontmatter } = parseSkillMarkdown(
    "---\ndescription: >-\n  Use when: the user asks.\nname: ok\n---\n",
  );
  expect(frontmatter.description).toBe("Use when: the user asks.");
  expect(frontmatter.name).toBe("ok");
  expect(Object.keys(frontmatter).sort()).toEqual(["description", "name"]);
});

test("block scalars with indentation indicators (`>2`, `|2-`, `>-2`) parse, never leak the marker", () => {
  // YAML allows chomping and indentation indicators in either order; the old
  // regex only knew bare `>`/`|`/`>-`/`|+`, so `>2` stored the literal ">2" as
  // the description and silently dropped the block — the same "garbage
  // description" class the block-scalar support was added to fix.
  for (const marker of [">2", ">2-", ">-2", "|1"]) {
    const { frontmatter } = parseSkillMarkdown(
      `---\nname: ind\ndescription: ${marker}\n  hello world\nlicense: MIT\n---\nBody.\n`,
    );
    expect([marker, frontmatter.description]).toEqual([marker, "hello world"]);
    expect(frontmatter.license).toBe("MIT"); // following key still parsed
  }
  // A non-scalar value that merely starts with `>` is NOT treated as a block.
  const { frontmatter } = parseSkillMarkdown("---\ndescription: > junk\n---\n");
  expect(frontmatter.description).toBe("> junk");
});

test("descriptions() caps each prompt-resident line — a folded essay can't tax every turn", () => {
  const reg = new SkillRegistry();
  reg.register({
    name: "wordy",
    description: "x".repeat(5000),
    dir: "/tmp/wordy",
    load: async () => "",
  });
  const [line] = reg.descriptions();
  expect(line!.length).toBe(500);
  expect(line!.endsWith("…")).toBe(true);
  expect(line!.startsWith("- wordy: xxx")).toBe(true);
  // A normal description is untouched.
  reg.register({ name: "tidy", description: "Short.", dir: "/tmp/tidy", load: async () => "" });
  expect(reg.descriptions()[1]).toBe("- tidy: Short.");
  // The cut is code-point safe: an emoji straddling the cap boundary is dropped
  // whole, never stranded as a lone surrogate half.
  reg.register({ name: "emoji", description: "🎉".repeat(300), dir: "/tmp/emoji", load: async () => "" });
  const capped = reg.descriptions()[2]!;
  expect(capped.endsWith("…")).toBe(true);
  for (let i = 0; i < capped.length; i++) {
    const c = capped.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) expect(capped.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
  }
});
