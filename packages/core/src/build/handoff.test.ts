import { test, expect } from "bun:test";
import { parseHandoff, formatHandoffForKickoff, stripHandoffFence, HANDOFF_INSTRUCTION } from "./handoff.ts";

test("parses a full handoff block", () => {
  const report = `I refactored the auth module.

\`\`\`handoff
key_facts:
- JWT verification moved to middleware/auth.ts
- the login route now returns 401 (was 403) on bad credentials
files_touched:
- src/middleware/auth.ts
- src/routes/login.ts
open_questions:
- should refresh tokens rotate?
\`\`\``;
  const h = parseHandoff(report);
  expect(h?.keyFacts).toHaveLength(2);
  expect(h?.keyFacts[0]).toContain("middleware/auth.ts");
  expect(h?.filesTouched).toEqual(["src/middleware/auth.ts", "src/routes/login.ts"]);
  expect(h?.openQuestions).toEqual(["should refresh tokens rotate?"]);
});

test("tolerant: missing block → null; empty block → null; inline form works", () => {
  expect(parseHandoff("just prose, no block")).toBeNull();
  expect(parseHandoff("```handoff\n```")).toBeNull();
  const h = parseHandoff("```handoff\nkey_facts: single inline fact\n```");
  expect(h?.keyFacts).toEqual(["single inline fact"]);
});

test("uses the LAST handoff fence when several appear", () => {
  const text = "```handoff\nkey_facts:\n- old\n```\nrevised...\n```handoff\nkey_facts:\n- new\n```";
  expect(parseHandoff(text)?.keyFacts).toEqual(["new"]);
});

test("unknown sections are ignored; caps applied", () => {
  const many = Array.from({ length: 30 }, (_, i) => `- fact ${i}`).join("\n");
  const h = parseHandoff(`\`\`\`handoff\nbogus_section:\n- nope\nkey_facts:\n${many}\n\`\`\``);
  expect(h?.keyFacts).toHaveLength(12);
  expect(h?.keyFacts.some((f) => f === "nope")).toBe(false);
});

test("formatHandoffForKickoff renders fields verbatim + read_report pointer", () => {
  const out = formatHandoffForKickoff("t1", {
    keyFacts: ["API is /v2 now"],
    filesTouched: ["src/api.ts"],
    openQuestions: [],
  });
  expect(out).toContain("[t1] handoff:");
  expect(out).toContain("API is /v2 now");
  expect(out).toContain('read_report("t1")');
});

test("stripHandoffFence removes a trailing block, leaves prose intact", () => {
  const text = "The work is done.\n\n```handoff\nkey_facts:\n- x\n```";
  expect(stripHandoffFence(text)).toBe("The work is done.");
  expect(stripHandoffFence("no fence here")).toBe("no fence here");
});

test("the kickoff instruction mentions every section", () => {
  for (const s of ["key_facts", "files_touched", "open_questions"]) {
    expect(HANDOFF_INSTRUCTION).toContain(s);
  }
});
