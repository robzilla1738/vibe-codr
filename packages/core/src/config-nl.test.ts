import { test, expect } from "bun:test";
import { defaultConfig } from "@vibe/config";
import {
  applyConfigPatch,
  formatConfigSection,
  parseConfigNatural,
  parseGoalSettings,
  parseLoopSettings,
} from "./config-nl.ts";

test("parseConfigNatural: empty → null (show full config)", () => {
  expect(parseConfigNatural("")).toBeNull();
  expect(parseConfigNatural("   ")).toBeNull();
});

test("parseConfigNatural: natural goal max rounds", () => {
  const r = parseConfigNatural("set the goal max rounds to 15");
  expect(r).toEqual({
    kind: "set",
    patch: { goal: { maxRounds: 15 } },
    description: "goal.maxRounds = 15",
  });
});

test("parseConfigNatural: goal plan first off", () => {
  const r = parseConfigNatural("goal plan first off");
  expect(r).toMatchObject({ kind: "set", patch: { goal: { planFirst: false } } });
});

test("parseConfigNatural: loop default max unlimited", () => {
  const r = parseConfigNatural("loop default max unlimited");
  expect(r).toMatchObject({ kind: "set", patch: { loop: { defaultMax: 0 } } });
});

test("parseConfigNatural: plan thoroughness knobs", () => {
  expect(parseConfigNatural("plan min code touches 5")).toMatchObject({
    kind: "set",
    patch: { plan: { minCodeTouches: 5 } },
  });
  expect(parseConfigNatural("plan require webfetch off")).toMatchObject({
    kind: "set",
    patch: { plan: { requireWebFetch: false } },
  });
  expect(parseConfigNatural("plan.allowUngrounded false")).toMatchObject({
    kind: "set",
    patch: { plan: { allowUngrounded: false } },
  });
});

test("parseConfigNatural: show subsection", () => {
  expect(parseConfigNatural("show goal")).toEqual({ kind: "show", section: "goal" });
  expect(parseConfigNatural("plan")).toEqual({ kind: "show", section: "plan" });
});

test("parseConfigNatural: out-of-range errors", () => {
  const r = parseConfigNatural("goal max rounds 999");
  expect(r?.kind).toBe("error");
});

test("parseGoalSettings: only unambiguous shapes", () => {
  expect(parseGoalSettings("max 12")).toMatchObject({
    kind: "set",
    patch: { goal: { maxRounds: 12 } },
  });
  expect(parseGoalSettings("plan first on")).toMatchObject({
    kind: "set",
    patch: { goal: { planFirst: true } },
  });
  expect(parseGoalSettings("settings")).toEqual({ kind: "show", section: "goal" });
  // Real goal prose must NOT be stolen.
  expect(parseGoalSettings("max out the throughput")).toBeNull();
  expect(parseGoalSettings("ship the auth feature")).toBeNull();
});

test("parseLoopSettings: defaults without starting a loop", () => {
  expect(parseLoopSettings("defaults")).toEqual({ kind: "show", section: "loop" });
  expect(parseLoopSettings("default max 20")).toMatchObject({
    kind: "set",
    patch: { loop: { defaultMax: 20 } },
  });
  expect(parseLoopSettings("30s check the build --max 3")).toBeNull();
});

test("applyConfigPatch deep-merges nested keys", () => {
  const cfg = defaultConfig();
  applyConfigPatch(cfg as unknown as Record<string, unknown>, { goal: { maxRounds: 7 } });
  expect(cfg.goal.maxRounds).toBe(7);
  expect(cfg.goal.planFirst).toBe(true); // preserved
  applyConfigPatch(cfg as unknown as Record<string, unknown>, { plan: { minCodeTouches: 8 } });
  expect(cfg.plan.minCodeTouches).toBe(8);
  expect(cfg.plan.requireWebFetch).toBe(true);
});

test("formatConfigSection lists knobs", () => {
  const s = formatConfigSection(defaultConfig());
  expect(s).toContain("goal.maxRounds");
  expect(s).toContain("loop.defaultMax");
  expect(s).toContain("plan.minCodeTouches");
});
