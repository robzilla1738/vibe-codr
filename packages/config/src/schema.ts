import { z } from "zod";

/** Per-provider overrides (api key + base URL). */
export const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
});

/** allow/deny/ask policy for a tool, matched by glob on the tool name. */
export const PermissionRuleSchema = z.object({
  tool: z.string(),
  action: z.enum(["allow", "deny", "ask"]),
});

export const ConfigSchema = z.object({
  /** Default model string, e.g. "anthropic/claude-opus-4-8" or "lmstudio/<id>". */
  model: z.string().default("anthropic/claude-opus-4-8"),
  /** Start mode. */
  mode: z.enum(["plan", "execute"]).default("execute"),
  /** Hard cap on agentic steps per turn. */
  maxSteps: z.number().int().positive().default(64),
  /** Per-provider credential/baseURL overrides (env vars take precedence). */
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  /** Tool permission rules, evaluated in order; first match wins. */
  permissions: z.array(PermissionRuleSchema).default([]),
  /** UI theme name. */
  theme: z.string().default("default"),
  /** Plugin module specifiers (npm names or local paths). */
  plugins: z.array(z.string()).default([]),
  subagent: z
    .object({
      maxDepth: z.number().int().positive().default(3),
    })
    .default({ maxDepth: 3 }),
  compaction: z
    .object({
      /** Fraction of context window at which to auto-compact. */
      threshold: z.number().min(0.1).max(0.95).default(0.75),
    })
    .default({ threshold: 0.75 }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
