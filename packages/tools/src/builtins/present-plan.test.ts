import { test, expect } from "bun:test";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { presentPlanTool } from "./present-plan.ts";

function ctx(): { ctx: ToolContext; events: UIEvent[] } {
  const events: UIEvent[] = [];
  return {
    events,
    ctx: {
      cwd: "/tmp",
      sessionId: "ses_plan",
      abortSignal: new AbortController().signal,
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
  // The tool's own output tells the model to stop, not to keep editing.
  expect(res.isError).toBeUndefined();
  expect(res.output).toContain("Plan presented");
});

test("is read-only and gated to plan mode", () => {
  expect(presentPlanTool.readOnly).toBe(true);
  expect(presentPlanTool.modes).toEqual(["plan"]);
});
