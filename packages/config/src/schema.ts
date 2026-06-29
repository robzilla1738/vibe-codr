import { z } from "zod";

/** Per-provider overrides (api key + base URL + subscription/OAuth token file). */
export const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  /**
   * Path to a credential file to read the key/token from (supports `~`). Used to
   * reuse a subscription/OAuth token another CLI already obtained — e.g. Codex's
   * `~/.codex/auth.json`. A JSON file is searched for common key fields (or use
   * `tokenPath`); a plain-text file is used verbatim.
   */
  tokenFile: z.string().optional(),
  /** Dot-path into a JSON token file (e.g. "tokens.access_token"). */
  tokenPath: z.string().optional(),
  /** Extra HTTP headers sent with every request (e.g. an account id for a gateway). */
  headers: z.record(z.string(), z.string()).optional(),
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

/** An MCP server: a local stdio process or a remote SSE/HTTP URL. */
export const McpServerSchema = z.union([
  z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

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
  /** Workspace checkpoints before each edit turn (git repos only). */
  checkpoints: z
    .object({ enabled: z.boolean().default(true) })
    .default({ enabled: true }),
  /** MCP servers to connect; their tools register as `mcp__<server>__<tool>`. */
  mcp: z
    .object({ servers: z.record(z.string(), McpServerSchema).default({}) })
    .default({ servers: {} }),
  /**
   * Self-verification: a shell command (e.g. "bun run typecheck && bun test")
   * run after edit turns. `auto` feeds failures back so the agent self-corrects,
   * up to `maxRetries` times. Always runnable on demand via `/verify`.
   */
  verify: z
    .object({
      command: z.string().optional(),
      auto: z.boolean().default(false),
      maxRetries: z.number().int().min(0).max(10).default(2),
    })
    .default({ auto: false, maxRetries: 2 }),
  /**
   * Per-model price overrides keyed by model string (`provider/model`), in USD
   * per 1M tokens. Used for cost tracking when a model is missing from the
   * catalog or you want to pin a negotiated rate. Overrides catalog pricing.
   */
  pricing: z.record(z.string(), ModelPriceSchema).default({}),
  /**
   * Per-model context-window overrides keyed by model string (`provider/model`),
   * in tokens. Used to pin the real window for a model the catalog doesn't know
   * (e.g. a custom Ollama tag), driving accurate context-fill % and compaction.
   * Wins over the live Ollama probe and the catalog.
   */
  contextWindow: z.record(z.string(), z.number().int().positive()).default({}),
  /**
   * Extended-thinking / reasoning controls, passed to the provider when the
   * model supports them. `effort` maps to OpenAI `reasoningEffort` (and
   * OpenRouter); `budgetTokens` maps to Anthropic extended-thinking budget.
   */
  reasoning: z
    .object({
      effort: z.enum(["low", "medium", "high"]).optional(),
      budgetTokens: z.number().int().positive().optional(),
    })
    .default({}),
  /**
   * Prompt caching. When enabled (default), the stable system prefix is sent
   * with provider cache markers (Anthropic) so repeated turns reuse it instead
   * of re-billing the full prompt each step.
   */
  caching: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  /**
   * Spend guard. When cumulative session cost crosses `limitUSD`, `warn` emits a
   * notice; `stop` also aborts the turn. No limit set = unbounded.
   */
  budget: z
    .object({
      limitUSD: z.number().positive().optional(),
      onExceed: z.enum(["warn", "stop"]).default("warn"),
    })
    .default({ onExceed: "warn" }),
  /** Transient-error retry policy for provider calls (network / 429 / 5xx). */
  retry: z
    .object({
      maxAttempts: z.number().int().min(0).max(10).default(2),
      baseDelayMs: z.number().int().min(0).max(60_000).default(500),
    })
    .default({ maxAttempts: 2, baseDelayMs: 500 }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
