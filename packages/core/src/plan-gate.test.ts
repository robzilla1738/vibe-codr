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
