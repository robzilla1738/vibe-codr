import { z } from "zod";

const boundedText = (max: number) => z.string().min(1).max(max).refine((value) => !value.includes("\0"), "NUL is not allowed");

export const AutomationActionV1Schema = z.object({
  prompt: boundedText(100_000).optional(),
  goal: boundedText(10_000).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.prompt === undefined) === (value.goal === undefined)) {
    ctx.addIssue({ code: "custom", message: "exactly one of prompt or goal is required" });
  }
});

export const AutomationTriggerV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), everyMs: z.number().int().min(60_000).max(31_536_000_000) }).strict(),
  z.object({ kind: z.literal("cron"), expression: boundedText(128), timezone: z.literal("UTC").default("UTC") }).strict(),
]);

export const AutomationSpecV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: boundedText(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  workspace: boundedText(4096),
  action: AutomationActionV1Schema,
  model: boundedText(512).optional(),
  tier: z.enum(["default", "cheap", "strong"]).default("default"),
  mode: z.enum(["plan", "execute"]).default("plan"),
  trigger: AutomationTriggerV1Schema,
  timeoutMs: z.number().int().min(1_000).max(86_400_000).default(1_800_000),
  spendCeilingUSD: z.number().finite().positive().max(10_000).default(5),
  permissionProfile: boundedText(128).default("default"),
  sandboxPolicy: z.object({
    mode: z.enum(["read-only", "workspace-write"]).default("read-only"),
    network: z.enum(["off", "on"]).default("off"),
  }).strict().default({ mode: "read-only", network: "off" }),
  branchPolicy: z.enum(["none", "branch", "worktree"]).default("none"),
  enabled: z.boolean().default(true),
  overlapPolicy: z.literal("skip").default("skip"),
  missedRunPolicy: z.literal("skip").default("skip"),
}).strict();

export type AutomationActionV1 = z.infer<typeof AutomationActionV1Schema>;
export type AutomationTriggerV1 = z.infer<typeof AutomationTriggerV1Schema>;
export type AutomationSpecV1 = z.infer<typeof AutomationSpecV1Schema>;

export function automationCanMutate(spec: AutomationSpecV1): boolean {
  return spec.mode === "execute" || spec.sandboxPolicy.mode === "workspace-write" || spec.branchPolicy !== "none";
}
