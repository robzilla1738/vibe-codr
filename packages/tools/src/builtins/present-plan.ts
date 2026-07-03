import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

const Source = z.object({
  url: z.string().describe("URL of the page this plan's facts rest on."),
  title: z.string().optional().describe("Page title, when known."),
});

const Input = z.object({
  plan: z
    .string()
    .describe("The complete implementation plan, formatted as markdown."),
  sources: z
    .array(Source)
    .optional()
    .describe(
      "Web pages the plan is grounded in (from your web_search/webfetch this " +
        "session). REQUIRED when the plan rests on researched real-world facts " +
        "— a plan that cites nothing it researched will be rejected.",
    ),
  assumptions: z
    .array(z.string())
    .optional()
    .describe(
      "Anything the plan needs that you could NOT verify (marked 'inferred — " +
        "verify' in the plan). Surfaced to the user distinctly from researched fact.",
    ),
});

/**
 * Plan-mode terminal tool. The model calls this when its plan is ready; the
 * engine surfaces the plan and the user approves by switching to execute mode.
 * The session's plan-readiness gate (ctx.planGate) is consulted first: when the
 * request demanded research that never happened, the call is REJECTED with
 * concrete instructions so the model goes back to GATHER instead of shipping an
 * ungrounded plan. After the gate's rejection budget is spent, the plan passes
 * with an `ungrounded` warning rather than deadlocking the model.
 */
export const presentPlanTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "present_plan",
  description:
    "Present your finished plan for the user to review. Call this once your plan is complete " +
    "AND grounded — the engine rejects a plan whose required research (web_search / package_info " +
    "/ file reads) never happened. Pass the web pages the plan rests on in `sources` and any " +
    "unverified items in `assumptions`. Do not modify any files — switching to execute mode is " +
    "the user's decision.",
  inputSchema: Input,
  readOnly: true,
  modes: ["plan"],
  async execute({ plan, sources, assumptions }, ctx) {
    const verdict = ctx.planGate?.({ ...(sources ? { sources } : {}) });
    if (verdict && !verdict.allow) {
      return { output: verdict.reason ?? "Plan rejected — required grounding is missing.", isError: true };
    }
    ctx.emit({
      type: "plan-presented",
      sessionId: ctx.sessionId,
      plan,
      ...(sources?.length ? { sources } : {}),
      ...(assumptions?.length ? { assumptions } : {}),
      ...(verdict?.ungrounded ? { ungrounded: true } : {}),
    });
    return {
      output:
        "Plan presented to the user. Stop here — the user will switch to execute mode if they approve.",
    };
  },
};
