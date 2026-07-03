import { test, expect } from "bun:test";
import { PlanGate, triagePlanRequest } from "./plan-gate.ts";

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

  // No research at all → rejected with concrete instructions.
  const first = gate.evaluate({});
  expect(first.allow).toBe(false);
  expect(first.reason).toContain("web_search");

  const second = gate.evaluate({});
  expect(second.allow).toBe(false);

  // Budget spent → allowed through, but stamped ungrounded.
  const third = gate.evaluate({});
  expect(third.allow).toBe(true);
  expect(third.ungrounded).toBe(true);
});

test("gate: research telemetry + sources satisfy the requirements", () => {
  const gate = new PlanGate();
  gate.noteRequest("build a next.js site about today's world cup match");
  gate.recordToolUse("web_search");
  gate.recordToolUse("webfetch");
  gate.recordToolUse("package_info");

  // Searched but presented without citing sources → still bounced.
  const noSources = gate.evaluate({});
  expect(noSources.allow).toBe(false);
  expect(noSources.reason).toContain("sources");

  const grounded = gate.evaluate({ sources: [{ url: "https://fifa.com/match" }] });
  expect(grounded.allow).toBe(true);
  expect(grounded.ungrounded).toBeUndefined();
});

test("gate: self-contained requests pass immediately — no research theater", () => {
  const gate = new PlanGate();
  gate.noteRequest("rename parseCfg to parseConfig across the repo");
  gate.recordToolUse("grep"); // the code requirement is satisfied by one read
  expect(gate.evaluate({}).allow).toBe(true);

  const pure = new PlanGate();
  pure.noteRequest("write a limerick about rust");
  expect(pure.evaluate({}).allow).toBe(true);
});

test("gate: code requirement is waived in a greenfield workspace", () => {
  const gate = new PlanGate({ greenfield: true });
  gate.noteRequest("refactor the loader in this codebase"); // needsCode, but nothing to read
  expect(gate.evaluate({}).allow).toBe(true);
});

test("gate: revision prompts UNION into the triage; telemetry accumulates", () => {
  const gate = new PlanGate();
  gate.noteRequest("write a static page"); // no requirements
  gate.noteRequest("actually make it about today's match"); // now web-bound
  expect(gate.evaluate({}).allow).toBe(false);
  gate.recordToolUse("web_search");
  expect(gate.evaluate({ sources: [{ url: "https://example.com" }] }).allow).toBe(true);
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
  for (const req of ["traverse each tree node", "the react component needs a fix", "add a spring animation"]) {
    expect([req, triagePlanRequest(req).needsVersions]).toEqual([req, false]);
  }
});

test("gate: junk/non-URL sources do NOT satisfy the web-evidence requirement", () => {
  const gate = new PlanGate();
  gate.noteRequest("plan a page about today's match");
  gate.recordToolUse("web_search"); // a search happened…
  // …but the cited "sources" are not real URLs — the gate still demands evidence.
  expect(gate.evaluate({ sources: [{ url: "appease" }] }).allow).toBe(false);
  expect(gate.evaluate({ sources: [{ url: "data:text/plain,x" }] }).allow).toBe(false);
  // A real http(s) URL passes.
  expect(gate.evaluate({ sources: [{ url: "https://fifa.com/match" }] }).allow).toBe(true);
});
