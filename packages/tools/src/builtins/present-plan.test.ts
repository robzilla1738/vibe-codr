import { test, expect } from "bun:test";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { FreshnessRegistry } from "./freshness.ts";

const freshness = new FreshnessRegistry();
import { presentPlanTool } from "./present-plan.ts";

function ctx(): { ctx: ToolContext; events: UIEvent[] } {
  const events: UIEvent[] = [];
  return {
    events,
    ctx: {
      cwd: "/tmp",
      sessionId: "ses_plan",
      abortSignal: new AbortController().signal,
      freshness,
      emit: (e) => events.push(e),
      toolCallId: "call_1",
    },
  };
}

test("emits a plan-presented event carrying the plan text", async () => {
  const { ctx: c, events } = ctx();
  const plan = "# Plan\n\n1. Add the parser\n2. Wire it up\n3. Test";
  const res = await presentPlanTool.execute({ plan }, c);

  const ev = events.find((e) => e.type === "plan-presented") as
    | Extract<UIEvent, { type: "plan-presented" }>
    | undefined;
  expect(ev).toBeDefined();
  expect(ev!.plan).toBe(plan);
  expect(ev!.sessionId).toBe("ses_plan");
  // Terminal action: success copy hard-stops tooling and waits for user approve.
  expect(res.isError).toBeUndefined();
  expect(res.output).toContain("Plan presented");
  expect(String(res.output)).toMatch(/STOP/i);
  expect(String(res.output)).toMatch(/further tools are disabled/i);
  expect(String(res.output)).toMatch(/Wait for the user/i);
});

test("is read-only and gated to plan mode", () => {
  expect(presentPlanTool.readOnly).toBe(true);
  expect(presentPlanTool.modes).toEqual(["plan"]);
});

test("tool description frames present_plan as the sole approval channel", () => {
  expect(presentPlanTool.description).toMatch(/ONLY way to ship a plan/i);
  expect(presentPlanTool.description).toMatch(/further tools/i);
});
