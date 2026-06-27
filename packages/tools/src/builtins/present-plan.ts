import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

const Input = z.object({
  plan: z
    .string()
    .describe("The complete implementation plan, formatted as markdown."),
});

/**
 * Plan-mode terminal tool. The model calls this when its plan is ready; the
 * engine surfaces the plan and the user approves by switching to execute mode.
 */
export const presentPlanTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "present_plan",
  description:
    "Present your finished plan for the user to review. Call this once your plan is complete. Do not modify any files — switching to execute mode is the user's decision.",
  inputSchema: Input,
  readOnly: true,
  modes: ["plan"],
  async execute({ plan }, ctx) {
    ctx.emit({ type: "plan-presented", sessionId: ctx.sessionId, plan });
    return {
      output:
        "Plan presented to the user. Stop here — the user will switch to execute mode if they approve.",
    };
  },
};
