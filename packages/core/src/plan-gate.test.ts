import { test, expect } from "bun:test";
import { PlanGate, triagePlanRequest, MIN_CODE_TOUCHES } from "./plan-gate.ts";
import { SourceLedger } from "./source-ledger.ts";

test("triage: time-sensitive / current-events requests need web research", () => {
  expect(triagePlanRequest("build a site about today's world cup match").needsWeb).toBe(true);
  expect(triagePlanRequest("what's the latest on the election").needsWeb).toBe(true);
  expect(triagePlanRequest("show live stock price charts").needsWeb).toBe(true);
  expect(triagePlanRequest("rename this function to parseConfig").needsWeb).toBe(false);
});

test("triage: named stacks and greenfield builds need version lookups", () => {
  expect(triagePlanRequest("build a next.js site with tailwind").needsVersions).toBe(true);
  expect(triagePlanRequest("create a dashboard app for my metrics").needsVersions).toBe(true);
  expect(triagePlanRequest("add a --verbose flag").needsVersions).toBe(false);
});

test("triage: codebase references need file reads; self-contained work needs nothing", () => {
  expect(triagePlanRequest("refactor the loader in this codebase").needsCode).toBe(true);
  const trivial = triagePlanRequest("write a haiku");
  expect(trivial.needsWeb).toBe(false);
  expect(trivial.needsVersions).toBe(false);
  expect(trivial.needsCode).toBe(false);
});

test("gate: rejects an ungrounded present twice with instructions, then allows with a warning", () => {
  const gate = new PlanGate();
  gate.noteRequest("build a next.js site about today's world cup match");
  expect(gate.needsPresentNudge()).toBe(true);
  expect(gate.presented).toBe(false);

  // No research at all → rejected with concrete instructions.
  const first = gate.evaluate({});
  expect(first.allow).toBe(false);
  expect(first.reason).toContain("web_search");
  expect(gate.presented).toBe(false);
  expect(gate.needsPresentNudge()).toBe(true);

  const second = gate.evaluate({});
  expect(second.allow).toBe(false);

  // Budget spent → allowed through, but stamped ungrounded.
  const third = gate.evaluate({});
  expect(third.allow).toBe(true);
  expect(third.ungrounded).toBe(true);
  expect(gate.presented).toBe(true);
  expect(gate.needsPresentNudge()).toBe(false);
});

test("gate: a successful present clears the present nudge; a new request re-arms it", () => {
  const gate = new PlanGate();
  gate.noteRequest("write a haiku about rain");
  // Self-contained → nonTrivial false → no nudge even without present.
  expect(gate.nonTrivial).toBe(false);
  expect(gate.needsPresentNudge()).toBe(false);

  gate.noteRequest("build a next.js site about today's world cup match");
  expect(gate.needsPresentNudge()).toBe(true);

  gate.recordToolUse("web_search");
  gate.recordToolUse("webfetch");
  gate.recordToolUse("package_info");
  const ok = gate.evaluate({
    plan: "- [ ] scaffold\n- [ ] verify build\n",
    sources: [{ url: "https://example.com/match" }],
    verification: "next build",
    decisions: ["next.js — requested stack"],
  });
  // Without a harvested-source checker, any http(s) URL counts as shaped.
  expect(ok.allow).toBe(true);
  expect(gate.presented).toBe(true);
  expect(gate.needsPresentNudge()).toBe(false);

  // Revision prompt re-arms present requirement.
  gate.noteRequest("also add player photos");
  expect(gate.presented).toBe(false);
  expect(gate.needsPresentNudge()).toBe(true);
});

test("gate: needsWeb requires webfetch + harvested sources (search alone is not enough)", () => {
  const gate = new PlanGate();
  gate.noteRequest("build a next.js site about today's world cup match");
  gate.recordToolUse("web_search");
  gate.recordToolUse("package_info");

  // Search without webfetch → bounced for deep-read.
  const noFetch = gate.evaluate({
    plan: "- [ ] a\n- [ ] b\nVerification: tests\nDecision: next because X",
    sources: [{ url: "https://fifa.com/match" }],
  });
  expect(noFetch.allow).toBe(false);
  expect(noFetch.reason).toContain("webfetch");

  gate.recordToolUse("webfetch");
  // Fetched but presented without citing sources → still bounced.
  const noSources = gate.evaluate({
    plan: "- [ ] a\n- [ ] b\nVerification: tests\nDecision: next because X",
  });
  expect(noSources.allow).toBe(false);
  expect(noSources.reason).toMatch(/sources|assumptions/i);

  const grounded = gate.evaluate({
    plan: "- [ ] scaffold\n- [ ] verify with tests\n",
    sources: [{ url: "https://fifa.com/match" }],
    verification: "bun test",
    decisions: ["next.js — matches existing stack"],
  });
  expect(grounded.allow).toBe(true);
  expect(grounded.ungrounded).toBeUndefined();
});

test("gate: a webfetch-grounded plan with a cited source satisfies needsWeb — a bare webfetch with no source does not", () => {
  const harvested = new Set(["https://fifa.com/match"]);
  const isHarvested = (url: string) => harvested.has(url);

  // A direct webfetch that harvested a citable source grounds the plan when
  // structure is complete.
  const grounded = new PlanGate();
  grounded.noteRequest("plan a page about today's world cup match");
  grounded.recordToolUse("webfetch");
  const verdict = grounded.evaluate(
    {
      plan: "- [ ] page\n- [ ] ship\n",
      sources: [{ url: "https://fifa.com/match" }],
      verification: "manual check of the page",
    },
    { isHarvested },
  );
  expect(verdict.allow).toBe(true);
  expect(verdict.ungrounded).toBeUndefined();

  // A bare webfetch with no cited source is still bounced on the evidence gate.
  const bare = new PlanGate();
  bare.noteRequest("plan a page about today's world cup match");
  bare.recordToolUse("webfetch");
  const bounced = bare.evaluate(
    { plan: "- [ ] a\n- [ ] b\n", verification: "tests" },
    { isHarvested },
  );
  expect(bounced.allow).toBe(false);
  expect(bounced.reason).toMatch(/sources|assumptions/i);
});

test("gate: a fabricated citation is refused when the ledger can verify — only harvested URLs ground a plan", () => {
  const gate = new PlanGate();
  // Web-only request (no BUILD_REQUEST / stack → no package_info tax).
  gate.noteRequest("summarize today's world cup match");
  gate.recordToolUse("web_search");
  gate.recordToolUse("webfetch");
  const harvested = new Set(["https://fifa.com/match"]);
  const isHarvested = (url: string) => harvested.has(url);

  const fabricated = gate.evaluate(
    {
      plan: "- [ ] a\n- [ ] b\n",
      sources: [{ url: "https://fabricated-i-never-visited.example/x" }],
      verification: "tests",
    },
    { isHarvested },
  );
  expect(fabricated.allow).toBe(false);
  expect(fabricated.reason).toContain("never surfaced");

  const grounded = gate.evaluate(
    {
      plan: "- [ ] a\n- [ ] b\n",
      sources: [
        { url: "https://fabricated-i-never-visited.example/x" },
        { url: "https://fifa.com/match" },
      ],
      verification: "tests",
    },
    { isHarvested },
  );
  expect(grounded.allow).toBe(true);
});

test("gate: ledger verification tolerates equivalent URL spellings (SourceLedger.has)", () => {
  const ledger = new SourceLedger();
  ledger.record({ url: "https://www.fifa.com/match/?utm_source=x", via: "web_search" });
  const gate = new PlanGate();
  gate.noteRequest("plan a page about today's match");
  gate.recordToolUse("web_search");
  gate.recordToolUse("webfetch");
  const verdict = gate.evaluate(
    {
      plan: "- [ ] a\n- [ ] b\n",
      sources: [{ url: "https://fifa.com/match" }],
      verification: "tests",
    },
    { isHarvested: (url) => ledger.has(url) },
  );
  expect(verdict.allow).toBe(true);
});

test("gate: self-contained requests pass immediately — no research theater", () => {
  const gate = new PlanGate();
  gate.noteRequest("rename parseCfg to parseConfig across the repo");
  // needsCode: one touch is not enough — need MIN_CODE_TOUCHES or a scout.
  for (let i = 0; i < MIN_CODE_TOUCHES; i++) gate.recordToolUse("grep");
  expect(
    gate.evaluate({
      plan: "- [ ] rename\n- [ ] verify callers\n",
      verification: "typecheck + tests",
    }).allow,
  ).toBe(true);

  const pure = new PlanGate();
  pure.noteRequest("write a limerick about rust");
  expect(pure.evaluate({ plan: "just a poem" }).allow).toBe(true);
});

test("gate: needsCode requires thorough reads or a scout (not one ls)", () => {
  const gate = new PlanGate();
  gate.noteRequest("refactor the loader in this codebase");
  gate.recordToolUse("ls");
  const thin = gate.evaluate({
    plan: "- [ ] refactor\n- [ ] test\n",
    verification: "bun test",
  });
  expect(thin.allow).toBe(false);
  expect(thin.reason).toContain(String(MIN_CODE_TOUCHES));

  // A scout alone is enough.
  const scouted = new PlanGate();
  scouted.noteRequest("refactor the loader in this codebase");
  scouted.recordToolUse("spawn_subagent");
  expect(
    scouted.evaluate({
      plan: "- [ ] refactor\n- [ ] test\n",
      verification: "bun test",
    }).allow,
  ).toBe(true);
});

test("gate: needsVersions requires package_info (web_search alone is not enough)", () => {
  const gate = new PlanGate();
  gate.noteRequest("build a next.js site with tailwind");
  gate.recordToolUse("web_search");
  const noPkg = gate.evaluate({
    plan: "- [ ] scaffold\n- [ ] style\nDecision: next because X",
    verification: "build",
    assumptions: ["versions from search"],
  });
  expect(noPkg.allow).toBe(false);
  expect(noPkg.reason).toContain("package_info");

  gate.recordToolUse("package_info");
  expect(
    gate.evaluate({
      plan: "- [ ] scaffold\n- [ ] style\n",
      verification: "build",
      decisions: ["next.js + tailwind — standard"],
      assumptions: ["hosting TBD"],
    }).allow,
  ).toBe(true);
});

test("gate: non-trivial plans need checklist steps + verification", () => {
  const gate = new PlanGate();
  gate.noteRequest("refactor the loader in this codebase");
  for (let i = 0; i < MIN_CODE_TOUCHES; i++) gate.recordToolUse("read");
  const essay = gate.evaluate({ plan: "We should probably refactor the loader somehow." });
  expect(essay.allow).toBe(false);
  expect(essay.reason).toMatch(/step|checklist|verif/i);
});

test("gate: code requirement is waived in a greenfield workspace", () => {
  const gate = new PlanGate({ greenfield: true });
  gate.noteRequest("refactor the loader in this codebase"); // needsCode, but nothing to read
  // Still non-trivial structure applies (needsCode triage flag).
  expect(
    gate.evaluate({
      plan: "- [ ] invent loader\n- [ ] test it\n",
      verification: "manual",
    }).allow,
  ).toBe(true);
});

test("gate: revision prompts UNION into the triage; telemetry accumulates", () => {
  const gate = new PlanGate();
  gate.noteRequest("write a static page"); // no requirements
  gate.noteRequest("actually make it about today's match"); // now web-bound
  expect(gate.evaluate({}).allow).toBe(false);
  gate.recordToolUse("web_search");
  gate.recordToolUse("webfetch");
  expect(
    gate.evaluate({
      plan: "- [ ] page\n- [ ] publish\n",
      sources: [{ url: "https://example.com" }],
      verification: "look at it",
    }).allow,
  ).toBe(true);
});

test("gate: a new prompt re-arms the rejection budget — one exhausted plan can't disarm the next", () => {
  const gate = new PlanGate();
  gate.noteRequest("build a site about today's match"); // web-bound
  expect(gate.evaluate({}).allow).toBe(false); // bounce 1
  expect(gate.evaluate({}).allow).toBe(false); // bounce 2
  const waved = gate.evaluate({}); // budget exhausted for THIS request
  expect(waved.allow).toBe(true);
  expect(waved.ungrounded).toBe(true);

  // The user pivots to a new ask in the same plan stay: enforcement must be
  // back, not permanently disabled by the earlier plan's exhausted budget.
  gate.noteRequest("now plan a page for the latest election results");
  expect(gate.evaluate({}).allow).toBe(false);
});

test("triage: ordinary dev vocabulary does NOT force web/version research (false-positive fixes)", () => {
  // CURRENT_EVENTS / TIME_SENSITIVE / STACK_NAMES used to fire on these code words.
  const codeOnly = [
    "the function matches the pattern",
    "compute the relevance score",
    "cut a release build",
    "launch the app on startup",
    "add an announcement banner component",
    "traverse each tree node",
    "the react component needs a fix",
    "apply SOLID principles",
    "add a spring animation",
    "express the result as JSON",
  ];
  for (const req of codeOnly) {
    const t = triagePlanRequest(req);
    expect([req, t.needsWeb, t.needsVersions]).toEqual([req, false, false]);
  }
});

test("triage: genuine time-sensitive asks are still caught (false-negative fixes)", () => {
  expect(triagePlanRequest("who won the 2026 super bowl").needsWeb).toBe(true);
  expect(triagePlanRequest("summarize recent AI developments").needsWeb).toBe(true);
  expect(triagePlanRequest("current stock price of AAPL").needsWeb).toBe(true);
  // Greenfield build still forces versions via BUILD_REQUEST even without bare stack words.
  expect(triagePlanRequest("build a react app").needsVersions).toBe(true);
});

test("triage: UNAMBIGUOUS stack spellings still force versions (Node.js over-correction fixed)", () => {
  // node.js / nodejs / spring boot / react 19 carry no false-positive risk, so
  // they must still trigger needsVersions (bare node/react/spring do NOT).
  for (const req of [
    "which Node.js version should we target",
    "which nodejs version should we target",
    "set up a Node.js project",
    "set up an express server",
    "migrate to React 19",
    "add a spring boot microservice",
  ]) {
    expect([req, triagePlanRequest(req).needsVersions]).toEqual([req, true]);
  }
  // …while the ambiguous bare forms stay self-contained (no version tax).
  for (const req of [
    "traverse each tree node",
    "the react component needs a fix",
    "add a spring animation",
  ]) {
    expect([req, triagePlanRequest(req).needsVersions]).toEqual([req, false]);
  }
  // The `react <digit>` version clause requires TWO digits (`\d{2}\b`) — real
  // React majors are ≥15 — so the verb sense stays self-contained. The
  // adversarial P3 pass caught single-digit English ("react 2 seconds", "react 3
  // times", "react 500 ms") that a bare `\d` clause wrongly grounded.
  for (const req of [
    "express 3 concerns",
    "node 4 items in the list",
    "make the button react 2 seconds after the click",
    "have the animation react 3 times before stopping",
    "we will react 500 milliseconds later",
    "the UI should react\n3 different ways",
    "react 2024 retrospective",
  ]) {
    expect([req, triagePlanRequest(req).needsVersions]).toEqual([req, false]);
  }
  // Two-digit React version refs still ground (14/15/16/17/18/19/20…).
  for (const req of ["migrate to React 19", "upgrade to react 18", "react v20 rollout"]) {
    expect([req, triagePlanRequest(req).needsVersions]).toEqual([req, true]);
  }
});

test("gate: junk/non-URL sources do NOT satisfy the web-evidence requirement", () => {
  const gate = new PlanGate();
  gate.noteRequest("plan a page about today's match");
  gate.recordToolUse("web_search");
  gate.recordToolUse("webfetch");
  // …but the cited "sources" are not real URLs — the gate still demands evidence.
  expect(
    gate.evaluate({
      plan: "- [ ] a\n- [ ] b\n",
      sources: [{ url: "appease" }],
      verification: "x",
    }).allow,
  ).toBe(false);
  expect(
    gate.evaluate({
      plan: "- [ ] a\n- [ ] b\n",
      sources: [{ url: "data:text/plain,x" }],
      verification: "x",
    }).allow,
  ).toBe(false);
  // A real http(s) URL passes.
  expect(
    gate.evaluate({
      plan: "- [ ] a\n- [ ] b\n",
      sources: [{ url: "https://fifa.com/match" }],
      verification: "x",
    }).allow,
  ).toBe(true);
});
