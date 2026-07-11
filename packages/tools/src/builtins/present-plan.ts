import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

const Source = z.object({
  url: z.string().describe("URL of the page this plan's facts rest on."),
  title: z.string().optional().describe("Page title, when known."),
});

const Input = z.object({
  plan: z
    .string()
    .describe(
      "The complete implementation plan as markdown. Prefer a `- [ ] step` checklist " +
        "so execution can seed tasks. Non-trivial plans must include concrete steps, " +
        "key decisions with rationales, and how success will be verified.",
    ),
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
        "verify' in the plan). Surfaced to the user distinctly from researched fact. " +
        "Required when web/version research is incomplete.",
    ),
  files: z
    .array(z.string())
    .optional()
    .describe("Files, directories, or areas the plan will touch (or a single 'greenfield' entry)."),
  verification: z
    .string()
    .optional()
    .describe(
      "How success will be proven (commands to run, acceptance checks). Required " +
        "for non-trivial plans unless the plan body already has a verification section.",
    ),
  decisions: z
    .array(z.string())
    .optional()
    .describe(
      "Key decisions with a one-line rationale each (stack, API shape, trade-offs). " +
        "Required when the plan chooses frameworks or package versions.",
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
 *
 * After a successful present, the session forces toolChoice:"none" for the rest
 * of the turn so the model cannot keep tooling (skills, tasks, more research)
 * after the approval card is armed.
 */
export const presentPlanTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "present_plan",
  description:
    "Present your finished plan for user approval — the ONLY way to ship a plan " +
    "(free-form chat does not open the approval card). Call once the plan is complete " +
    "AND grounded — the engine rejects a plan whose required research (web_search / webfetch / " +
    "package_info / thorough file reads) never happened, or that lacks steps and verification. " +
    "Pass harvested page URLs in `sources`, unverified items in `assumptions`, and prefer " +
    "`verification` / `decisions` / `files` for non-trivial work. After success, further tools " +
    "are disabled this turn; wait for the user to accept (plan card / /execute) or revise.",
  inputSchema: Input,
  readOnly: true,
  modes: ["plan"],
  async execute({ plan, sources, assumptions, files, verification, decisions }, ctx) {
    const verdict = ctx.planGate?.({
      plan,
      ...(sources ? { sources } : {}),
      ...(assumptions ? { assumptions } : {}),
      ...(files ? { files } : {}),
      ...(verification ? { verification } : {}),
      ...(decisions ? { decisions } : {}),
    });
    if (verdict && !verdict.allow) {
      return {
        output: verdict.reason ?? "Plan rejected — required grounding is missing.",
        isError: true,
      };
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
        "Plan presented. STOP — further tools are disabled this turn. " +
        "Wait for the user to accept (plan card Enter or /execute) or revise.",
    };
  },
};
