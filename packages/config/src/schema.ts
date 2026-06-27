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

/** Web-search configuration (TinyFish: free tier, no card — agent.tinyfish.ai). */
export const SearchConfigSchema = z.object({
  /** Whether the `web_search` tool is offered to the model. */
  enabled: z.boolean().default(true),
  /** TinyFish API key. Env `TINYFISH_API_KEY` takes precedence. */
  apiKey: z.string().optional(),
});

/** Manual price override for a model, in USD per 1,000,000 tokens. */
export const ModelPriceSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
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
  /**
   * Default handling for side-effecting tools with no matching rule:
   * `ask` prompts interactively (auto-allowed when non-interactive),
   * `auto` runs them without asking. Read-only tools are never gated.
   */
  approvalMode: z.enum(["ask", "auto"]).default("ask"),
  /** UI theme name. */
  theme: z.string().default("default"),
  /** Plugin module specifiers (npm names or local paths). */
  plugins: z.array(z.string()).default([]),
  subagent: z
    .object({
      maxDepth: z.number().int().positive().default(3),
      /** Default model for subagents. Falls back to the main model when unset. */
      model: z.string().optional(),
    })
    .default({ maxDepth: 3 }),
  compaction: z
    .object({
      /** Fraction of context window at which to auto-compact. */
      threshold: z.number().min(0.1).max(0.95).default(0.75),
    })
    .default({ threshold: 0.75 }),
  /** Web search (TinyFish). Enabled by default; needs a free API key to run. */
  search: SearchConfigSchema.default({ enabled: true }),
  /**
   * Per-model price overrides keyed by model string (`provider/model`), in USD
   * per 1M tokens. Used for cost tracking when a model is missing from the
   * catalog or you want to pin a negotiated rate. Overrides catalog pricing.
   */
  pricing: z.record(z.string(), ModelPriceSchema).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
export type ModelPrice = z.infer<typeof ModelPriceSchema>;
