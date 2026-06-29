import { test, expect } from "bun:test";
import { composeSystemPrompt } from "./system-prompt.ts";

test("plan mode forbids edits; execute mode allows them", () => {
  expect(composeSystemPrompt({ mode: "plan", goal: null })).toContain("MUST NOT modify");
  expect(composeSystemPrompt({ mode: "execute", goal: null })).toContain(
    "may read and modify",
  );
});

test("the base prompt sets the quality bar: conventions, verification, concision, scope", () => {
  const out = composeSystemPrompt({ mode: "execute", goal: null });
  // Convention-matching and scope discipline (drives fit on real codebases).
  expect(out).toMatch(/match the surrounding code|patterns the project already uses/i);
  expect(out).toMatch(/minimal and scoped|don't refactor unrelated/i);
  // Verification rigor and terminal-appropriate communication.
  expect(out).toMatch(/run the project's checks|don't claim something works/i);
  expect(out).toMatch(/concise|skimmable/i);
});

test("the goal is injected as a north-star block", () => {
  const out = composeSystemPrompt({ mode: "execute", goal: "ship v1" });
  expect(out).toContain("NORTH-STAR GOAL: ship v1");
});

test("skill descriptions are surfaced for progressive disclosure", () => {
  const out = composeSystemPrompt({
    mode: "execute",
    goal: null,
    skillDescriptions: ["- pdf: Work with PDFs"],
  });
  expect(out).toContain("AVAILABLE SKILLS");
  expect(out).toContain("- pdf: Work with PDFs");
});

test("project memory is included when present", () => {
  const out = composeSystemPrompt({
    mode: "execute",
    goal: null,
    projectMemory: "This is a Bun monorepo.",
  });
  expect(out).toContain("This is a Bun monorepo.");
});
