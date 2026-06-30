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
  // Adaptive search: fast on quick facts, exhaustive when it matters (no throttle).
  expect(out).toMatch(/in proportion to the question/i);
  expect(out).toMatch(/Quick facts/i);
  expect(out).toMatch(/exhaustive|real depth|be thorough/i);
  // Authoritative version lookups go through package_info, not blog scraping.
  expect(out).toMatch(/package_info/);
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

test("the delegation doctrine appears only when subagents are available", () => {
  const without = composeSystemPrompt({ mode: "execute", goal: null });
  expect(without).not.toContain("DELEGATING TO SUBAGENTS");

  const withSub = composeSystemPrompt({
    mode: "execute",
    goal: null,
    subagentsAvailable: true,
  });
  expect(withSub).toContain("DELEGATING TO SUBAGENTS");
  expect(withSub).toMatch(/DISJOINT FILE OWNERSHIP/);
  expect(withSub).toMatch(/CONSOLIDATE AND VERIFY/);
  // Execute-mode doctrine pushes parallel fan-out in one step.
  expect(withSub).toMatch(/same step/i);
});

test("plan mode gets a read-only exploration doctrine, not the edit doctrine", () => {
  const out = composeSystemPrompt({
    mode: "plan",
    goal: null,
    subagentsAvailable: true,
  });
  expect(out).toContain("DELEGATING TO SUBAGENTS (read-only)");
  expect(out).toMatch(/investigation only/i);
  // The write-oriented bullets don't belong in plan mode.
  expect(out).not.toContain("DISJOINT FILE OWNERSHIP");
});

test("the named-agent roster is injected for capability routing", () => {
  const out = composeSystemPrompt({
    mode: "execute",
    goal: null,
    subagentsAvailable: true,
    agentRoster: ["explore — map the codebase", "review — adversarial review"],
  });
  expect(out).toContain("NAMED AGENTS");
  expect(out).toContain("explore — map the codebase");
  // No roster section when subagents aren't available, even if a roster is passed.
  const off = composeSystemPrompt({
    mode: "plan",
    goal: null,
    agentRoster: ["explore — map the codebase"],
  });
  expect(off).not.toContain("NAMED AGENTS");
});

test("project memory is included when present", () => {
  const out = composeSystemPrompt({
    mode: "execute",
    goal: null,
    projectMemory: "This is a Bun monorepo.",
  });
  expect(out).toContain("This is a Bun monorepo.");
});
