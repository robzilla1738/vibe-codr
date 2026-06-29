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
