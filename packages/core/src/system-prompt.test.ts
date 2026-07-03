import { test, expect } from "bun:test";
import { composeSystemPrompt, formatToday, formatWorkspaceState } from "./system-prompt.ts";

test("plan mode forbids edits; execute mode allows them", () => {
  expect(composeSystemPrompt({ mode: "plan", goal: null })).toContain("do NOT modify");
  expect(composeSystemPrompt({ mode: "execute", goal: null })).toContain(
    "may read and modify",
  );
});

test("plan mode carries the research pipeline: triage → gather → ground → critique → present", () => {
  const out = composeSystemPrompt({ mode: "plan", goal: null });
  // The pipeline stages, in doctrine order (the agentswarm grounded-research shape).
  expect(out).toMatch(/TRIAGE(.|\n)*GATHER(.|\n)*GROUND(.|\n)*SELF-CRITIQUE(.|\n)*PRESENT/);
  // Triage short-circuits: trivial work must not be taxed with research theater.
  expect(out).toMatch(/research theater/);
  // Time-sensitive claims verified on the web, dates resolved against the
  // injected current date (the "yesterday's game as today" bug).
  expect(out).toMatch(/web_search/);
  expect(out).toMatch(/yesterday's event is never presented as today's/);
  // Stack versions come from package_info/official docs, never memory.
  expect(out).toMatch(/package_info/);
  expect(out).toMatch(/NEVER name a version from memory/);
  // Grounded-vs-inferred honesty: unresearched claims are marked, not asserted.
  expect(out).toMatch(/inferred — verify/);
  // Research-before-present ordering.
  expect(out).toMatch(/present_plan(.|\n)*LAST/);
  // Execute mode doesn't carry the plan pipeline.
  expect(composeSystemPrompt({ mode: "execute", goal: null })).not.toMatch(/SELF-CRITIQUE/);
});

test("today's date is injected into ENVIRONMENT with a staleness warning", () => {
  const out = composeSystemPrompt({
    mode: "execute",
    goal: null,
    cwd: "/Users/me/proj",
    today: "Thursday, July 2, 2026 (2026-07-02)",
  });
  expect(out).toContain("Today's date: Thursday, July 2, 2026 (2026-07-02)");
  expect(out).toMatch(/training data predates/);
  // The date alone is enough to render the ENVIRONMENT block (headless contexts).
  const noCwd = composeSystemPrompt({ mode: "execute", goal: null, today: "X (2026-07-02)" });
  expect(noCwd).toContain("ENVIRONMENT:");
  expect(noCwd).not.toContain("Working directory");
});

test("formatToday renders a weekday long form with an ISO anchor", () => {
  expect(formatToday(new Date(2026, 6, 2))).toBe("Thursday, July 2, 2026 (2026-07-02)");
  expect(formatToday(new Date(2026, 0, 9))).toBe("Friday, January 9, 2026 (2026-01-09)");
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

test("the base prompt carries a terminal output-formatting doctrine", () => {
  const out = composeSystemPrompt({ mode: "execute", goal: null });
  // Always-on (part of BASE), and it teaches the safe constructs + the trap that
  // produced raw `~*$58,400*` in the wild.
  expect(out).toMatch(/Format for the terminal/);
  expect(out).toMatch(/inline code/);
  expect(out).toMatch(/never bold/);
  expect(out).toMatch(/flanking/); // the *-against-$/digit failure mode
});

test("the prompt teaches the native data views (chart/pie/line/weather/sources)", () => {
  // Present in both modes so charts/weather/etc. render natively out of the box
  // instead of the model building an HTML file or plain text.
  for (const mode of ["plan", "execute"] as const) {
    const out = composeSystemPrompt({ mode, goal: null });
    expect(out).toMatch(/RICH DATA VIEWS/);
    for (const fence of ["```chart", "```pie", "```line", "```weather", "```sources"]) {
      expect(out).toContain(fence);
    }
    // The critical instruction: don't build HTML/a file for these unless asked.
    expect(out).toMatch(/do NOT build an HTML|explicitly asks for/i);
  }
});

test("the goal is injected as a north-star block", () => {
  const out = composeSystemPrompt({ mode: "execute", goal: "ship v1" });
  expect(out).toContain("NORTH-STAR GOAL: ship v1");
});

test("the cwd is injected so the model never has to run pwd or guess paths", () => {
  const out = composeSystemPrompt({ mode: "execute", goal: null, cwd: "/Users/me/proj" });
  expect(out).toContain("Working directory (cwd): /Users/me/proj");
  expect(out).toMatch(/do not run `pwd`/);
  // Absent when not provided (keeps the prompt clean in non-workspace contexts).
  expect(composeSystemPrompt({ mode: "execute", goal: null })).not.toContain("ENVIRONMENT:");
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

test("memory doctrine: full save guidance in execute, recall-only in plan, absent without memory", () => {
  // Execute with a wired MemoryService → recall + proactive-save doctrine.
  const full = composeSystemPrompt({ mode: "execute", goal: null, memory: { save: true } });
  expect(full).toContain("LONG-TERM MEMORY");
  expect(full).toContain("recall_memory");
  expect(full).toContain("save_memory");
  expect(full).toContain("AS YOU LEARN IT");
  // The doctrine teaches the taxonomy that matters: preferences, decisions with
  // rationale, gotchas — and what must never be saved.
  expect(full).toContain('scope "user"');
  expect(full).toContain("rationale");
  expect(full).toContain("secrets/credentials");
  // Plan mode (or no MemoryService): recall doctrine only — never coach a tool
  // the model doesn't have.
  const recallOnly = composeSystemPrompt({ mode: "plan", goal: null, memory: { save: false } });
  expect(recallOnly).toContain("recall_memory");
  expect(recallOnly).not.toContain("save_memory");
  // Omitted entirely when the memory tools aren't registered.
  expect(composeSystemPrompt({ mode: "execute", goal: null })).not.toContain("LONG-TERM MEMORY");
});

test("repo facts (recon) are injected before the goal", () => {
  const out = composeSystemPrompt({
    mode: "execute",
    goal: "ship it",
    repoFacts: "REPO FACTS (deterministic recon): test=`bun test`",
  });
  expect(out).toContain("REPO FACTS");
  expect(out.indexOf("REPO FACTS")).toBeLessThan(out.indexOf("NORTH-STAR GOAL"));
  // Absent when not provided.
  expect(composeSystemPrompt({ mode: "execute", goal: null })).not.toContain("REPO FACTS");
});

test("the task list lives in the workspace-state block, NOT the (cache-stable) system prompt", () => {
  const tasks = [
    { title: "read the code", status: "completed" as const },
    { title: "write the fix", status: "in_progress" as const },
    { title: "run the tests", status: "pending" as const },
  ];
  // The system prompt must stay byte-stable across turns for cross-turn caching,
  // so the volatile task list is NOT in it.
  const sys = composeSystemPrompt({ mode: "execute", goal: null });
  expect(sys).not.toContain("CURRENT TASKS");
  // It rides in the workspace-state reminder folded into the user turn instead.
  const state = formatWorkspaceState({ tasks });
  expect(state).toContain("<workspace-state>");
  expect(state).toContain("CURRENT TASKS");
  expect(state).toContain("[x] read the code");
  expect(state).toContain("[~] write the fix");
  expect(state).toContain("[ ] run the tests");
  // Nothing to report → no block at all (so no needless tokens on the user turn).
  expect(formatWorkspaceState({ tasks: [] })).toBeUndefined();
  expect(formatWorkspaceState({})).toBeUndefined();
});
