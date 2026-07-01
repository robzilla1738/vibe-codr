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

/** allow/deny/ask policy for a tool. `tool` globs the tool name; the optional
 * `match` globs the call's CONTENT (bash command, file path, URL) so policy can
 * say `{tool:"bash", match:"git push*", action:"deny"}`. Among matching rules,
 * deny > ask > allow regardless of order. */
export const PermissionRuleSchema = z.object({
  tool: z.string(),
  match: z.string().optional(),
  action: z.enum(["allow", "deny", "ask"]),
});

/** Web-search configuration (TinyFish: free tier, no card — agent.tinyfish.ai). */
export const SearchConfigSchema = z.object({
  /** Whether the `web_search` tool is offered to the model. */
  enabled: z.boolean().default(true),
  /** TinyFish API key. Env `TINYFISH_API_KEY` takes precedence. */
  apiKey: z.string().optional(),
});

/** webfetch SSRF policy + resource limits. Default-deny on private hosts. */
export const WebfetchConfigSchema = z.object({
  /** Allow fetching loopback/link-local/private/metadata hosts (intranet docs). */
  allowPrivateHosts: z.boolean().default(false),
  /** Hostnames always allowed even if they resolve to a private address. */
  allowHosts: z.array(z.string()).default([]),
  /** Per-fetch wall-clock cap (ms). */
  timeoutMs: z.number().int().positive().default(8_000),
  /** Byte ceiling pulled off the wire before the char cap. */
  maxBytes: z.number().int().positive().default(4_000_000),
});

/** A declarative lifecycle hook: run a shell command or POST to a URL on an
 * event, with the payload as JSON; the response can deny or rewrite it. */
export const HookSchema = z.object({
  /** Lifecycle event to hook (matches @vibe/plugins HookName). */
  event: z.enum([
    "session.start",
    "user.prompt.submit",
    "tool.before.execute",
    "tool.after.execute",
    "step.finish",
    "assistant.message",
    "session.idle",
    "session.end",
  ]),
  /** Glob matched against the tool name for tool.* events (omit = all). */
  matcher: z.string().optional(),
  /** Shell command; receives the payload as JSON on stdin. stdout JSON may carry
   * `{deny,reason}` (block a tool) or `{input}` (rewrite the tool input). */
  command: z.string().optional(),
  /** URL to POST the payload to (JSON in, JSON out, same protocol as `command`). */
  url: z.string().url().optional(),
  /** Fire-and-forget: don't await or let it block/deny (e.g. notifications). */
  async: z.boolean().default(false),
});

/** Long-term memory configuration (semantic recall + write-path + injection). */
export const MemoryConfigSchema = z.object({
  /** Semantic (embedding) recall fused with lexical BM25. NOTE: the default
   * "local" model needs the optional `@huggingface/transformers` dep installed —
   * without it recall silently runs lexical-only (BM25), which still works well.
   * `/doctor` reports which mode is active. */
  semantic: z
    .object({
      enabled: z.boolean().default(true),
      /** Embedding model: "local" for on-device ONNX (optional dep), or a
       * "provider/model" string for a cloud embedder (e.g. openai/text-embedding-3-small). */
      model: z.string().default("local"),
    })
    .default({ enabled: true, model: "local" }),
  /** Inject a goal-seeded "relevant past context" block at session start.
   * ON by default — bounded (top 3 hits, 300 chars each), so the continuity
   * win outweighs the prompt-cache churn. */
  proactiveRecall: z.boolean().default(true),
  /** Write a short digest at session end for future recall. ON by default —
   * one cheap model call per session buys cross-session continuity. */
  sessionDigest: z.boolean().default(true),
});

/** Manual price override for a model, in USD per 1,000,000 tokens. */
export const ModelPriceSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  /** Price of a cached-input (prompt-cache read) token. Defaults to `input` when
   * unset, so cost is never understated for a model without a known cache rate. */
  cacheRead: z.number().nonnegative().optional(),
  /** Price of writing the prompt cache (Anthropic bills ~1.25x input).
   * Defaults to `input` when unset — never understated to zero. */
  cacheWrite: z.number().nonnegative().optional(),
});

/** OAuth 2.1 for a remote MCP server. When present, the client runs the SDK's
 * authorization-code + PKCE flow and persists tokens locally (auto-refreshed). */
export const McpOAuthSchema = z.object({
  /** Requested scopes. */
  scopes: z.array(z.string()).optional(),
  /** Pre-registered client id (skips dynamic client registration). */
  clientId: z.string().optional(),
  /** Client name advertised during dynamic registration. */
  clientName: z.string().optional(),
  /** Redirect URI the local callback listens on. Default http://localhost:<port>/callback. */
  redirectUri: z.string().url().optional(),
  /** Override where tokens are stored (default ~/.config/vibe-codr/mcp/<server>.json). */
  tokenStore: z.string().optional(),
});

/** An MCP server: a local stdio process or a remote URL (Streamable HTTP or SSE). */
export const McpServerSchema = z.union([
  z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    /** Working directory for the spawned server process. */
    cwd: z.string().optional(),
    /** Set false to keep the server configured but not connect it. */
    enabled: z.boolean().optional(),
    /** Per-server connect/list deadline (ms). Overrides the hub default. */
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    url: z.string().url(),
    /** Remote transport: "http" (Streamable HTTP, the modern default) or "sse"
     * (legacy). Defaults to "http". */
    transport: z.enum(["http", "sse"]).optional(),
    /** Static auth/identity headers (e.g. `Authorization: Bearer …`). */
    headers: z.record(z.string(), z.string()).optional(),
    /** OAuth 2.1 (authorization-code + PKCE). Mutually complementary to `headers`. */
    oauth: McpOAuthSchema.optional(),
    /** Set false to keep the server configured but not connect it. */
    enabled: z.boolean().optional(),
    /** Per-server connect/list deadline (ms). Overrides the hub default. */
    timeoutMs: z.number().int().positive().optional(),
  }),
]);

export const ConfigSchema = z.object({
  /** Default model string, e.g. "anthropic/claude-opus-4-8" or "lmstudio/<id>". */
  model: z.string().default("anthropic/claude-opus-4-8"),
  /** Failover chain: when the active model can't be RESOLVED (missing key,
   * unknown provider/model), the session switches to the first resolvable
   * entry — with a visible notice + model-changed event — instead of dying.
   * Request-time failures still ride the retry policy. */
  modelFallbacks: z.array(z.string()).default([]),
  /** Start mode. */
  mode: z.enum(["plan", "execute"]).default("execute"),
  /** Hard cap on agentic steps per turn. */
  maxSteps: z.number().int().positive().default(64),
  /** Per-provider credential/baseURL overrides (env vars take precedence). */
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  /** Tool permission rules. Among matching rules: deny > ask > allow. */
  permissions: z.array(PermissionRuleSchema).default([]),
  /**
   * Default handling for side-effecting tools with no matching rule:
   * `ask` prompts interactively (auto-allowed when non-interactive),
   * `auto` runs them without asking. Pure read-only tools are never gated;
   * network read-only tools (webfetch/web_search/…) skip the prompt but DO
   * honor explicit permission rules, so policy can govern egress.
   */
  approvalMode: z.enum(["ask", "auto"]).default("ask"),
  /** UI theme name. */
  theme: z.string().default("default"),
  /** Accent hue (hex) for UI chrome that OVERRIDES the active theme's `primary`.
   * Empty by default so the theme's own brand (`#ff3503` on the default theme)
   * shows through; set a hex via config or `/accent <hex>` to override. */
  accentColor: z.string().default(""),
  /** Plugin module specifiers (npm names or local paths). */
  plugins: z.array(z.string()).default([]),
  /** Declarative lifecycle hooks (shell/HTTP) layered onto the in-process HookBus. */
  hooks: z.array(HookSchema).default([]),
  subagent: z
    .object({
      maxDepth: z.number().int().positive().default(3),
      /** Max subagents one agent runs concurrently (bounds each fan-out). */
      maxParallel: z.number().int().positive().default(8),
      /** Hard ceiling on TOTAL subagents spawned across a session tree — the
       * backstop against a runaway model spawning children forever (the cost
       * budget was previously the only guard). Generous by design. */
      maxTotal: z.number().int().positive().default(200),
      /** Tree-global ceiling on concurrent provider calls (distinct from the
       * logical maxParallel fan-out cap): the adaptive limiter never exceeds this.
       * High by default so it's a no-op for ordinary single-session use. */
      providerConcurrency: z.number().int().positive().default(16),
      /** Per-subagent wall-clock timeout (ms); a hung provider stream can't wedge
       * the parent's fan-out gate forever. 0 disables. Default 5 minutes. */
      timeoutMs: z.number().int().min(0).default(300_000),
      /** Max attempts for a verify→retry task (orchestrator `verify` flag): the
       * subagent re-runs with review feedback up to this many times. */
      verifyMaxAttempts: z.number().int().min(1).max(5).default(2),
      /** Default model for subagents. Falls back to the main model when unset. */
      model: z.string().optional(),
    })
    .default({
      maxDepth: 3,
      maxParallel: 8,
      maxTotal: 200,
      providerConcurrency: 16,
      timeoutMs: 300_000,
      verifyMaxAttempts: 2,
    }),
  /** Deterministic task-DAG orchestration (the `spawn_tasks` tool). ON by
   * default — the model can submit a whole dependency-ordered plan the engine
   * schedules (parallel where possible, verify→retry, structured handoffs);
   * the inline `spawn_subagent` path is unchanged. Disable to hide the tool. */
  orchestration: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  /**
   * Engine-owned build intelligence (all default-on, per-feature kill-switches):
   * deterministic repo recon injected into every agent's prompt, the `run_check`
   * tool, a real green-gate after mutating turns, green checkpoints, adversarial
   * diff review, and worktree isolation for parallel writer tasks.
   */
  build: z
    .object({
      /** Master switch — off restores the legacy verify.auto-only behavior. */
      enabled: z.boolean().default(true),
      /** After a green gate on a web app, boot the dev server headless and check
       * what static gates can't: does it render, is the console clean, and does
       * every visible control DO something. Needs the optional `playwright` peer
       * dep — absent, it degrades to a silent skip. */
      visualVerify: z.boolean().default(true),
      recon: z
        .object({
          enabled: z.boolean().default(true),
          /** Bootstrap recon from the cross-run ledger (.vibe/ledger.jsonl). */
          ledger: z.boolean().default(true),
        })
        .default({ enabled: true, ledger: true }),
      gate: z
        .object({
          enabled: z.boolean().default(true),
          /** Bounded red→fix→re-gate rounds per user prompt. */
          maxRounds: z.number().int().min(0).max(10).default(2),
          /** Which detected checks the gate runs (fail-fast order is fixed:
           * typecheck → test → build → lint). */
          checks: z
            .array(z.enum(["build", "typecheck", "test", "lint"]))
            .default(["typecheck", "test", "build"]),
          /** Per-check wall clock (seconds). */
          timeoutSec: z.number().int().positive().default(600),
        })
        .default({ enabled: true, maxRounds: 2, checks: ["typecheck", "test", "build"], timeoutSec: 600 }),
      commit: z
        .object({
          /** "checkpoint" (default): a passing gate writes a hidden-ref GREEN
           * checkpoint — dirty-tree-safe, never touches the user's branch.
           * "branch": agentswarm-style commits on a work branch (refuses a dirty
           * real repo). "off": no commit-on-green. */
          mode: z.enum(["checkpoint", "branch", "off"]).default("checkpoint"),
          branchPrefix: z.string().default("vibe/"),
        })
        .default({ mode: "checkpoint", branchPrefix: "vibe/" }),
      review: z
        .object({
          /** Adversarial diff review of the session's work once the gate is green. */
          enabled: z.boolean().default(true),
          maxRounds: z.number().int().min(0).max(5).default(1),
          /** Feed deterministic stub-scan findings (dead handlers, href="#", …)
           * into the review as advisory input. */
          stubScan: z.boolean().default(true),
        })
        .default({ enabled: true, maxRounds: 1, stubScan: true }),
      /** Allow `worktree: true` tasks to run in isolated git worktrees. */
      worktrees: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
      /** Best-of-N ensemble for `hard` tasks (N parallel worktree attempts,
       * gate-judged). 0 = off (the default — token-expensive). */
      ensemble: z.object({ n: z.number().int().min(0).max(5).default(0) }).default({ n: 0 }),
      /** Model tiers for task routing (TaskSpec.tier). Unset tiers fall back to
       * subagent.model → the parent's model. Must reference configured providers. */
      models: z
        .object({ cheap: z.string().optional(), strong: z.string().optional() })
        .default({}),
    })
    .default({
      enabled: true,
      visualVerify: true,
      recon: { enabled: true, ledger: true },
      gate: { enabled: true, maxRounds: 2, checks: ["typecheck", "test", "build"], timeoutSec: 600 },
      commit: { mode: "checkpoint", branchPrefix: "vibe/" },
      review: { enabled: true, maxRounds: 1, stubScan: true },
      worktrees: { enabled: true },
      ensemble: { n: 0 },
      models: {},
    }),
  compaction: z
    .object({
      /** Fraction of context window at which to auto-compact (LLM summary). */
      threshold: z.number().min(0.1).max(0.95).default(0.75),
      /**
       * Mid-turn microcompaction: bulky tool results are offloaded to session
       * artifacts (preview + path left in context, retrievable via `read`) when
       * fill crosses `threshold` — BELOW the summary threshold, so the lossless
       * mechanism runs first and summarization stays the last resort.
       */
      offload: z
        .object({
          enabled: z.boolean().default(true),
          threshold: z.number().min(0.1).max(0.9).default(0.6),
          /** Results at or above this many chars are offload-eligible. */
          maxResultBytes: z.number().int().positive().default(16_384),
          /** Inline preview kept in context per offloaded result. */
          previewBytes: z.number().int().positive().default(2_048),
          /** Never offload the most recent N tool results (the live working set). */
          keepLiveResults: z.number().int().min(0).default(2),
        })
        .default({
          enabled: true,
          threshold: 0.6,
          maxResultBytes: 16_384,
          previewBytes: 2_048,
          keepLiveResults: 2,
        }),
    })
    .default({
      threshold: 0.75,
      offload: { enabled: true, threshold: 0.6, maxResultBytes: 16_384, previewBytes: 2_048, keepLiveResults: 2 },
    }),
  /**
   * Long-term memory: semantic (embedding) recall on top of the lexical BM25
   * scorer, an agent write-path, and optional proactive injection. Everything
   * defaults to local/offline and degrades to lexical when no embedder is
   * available, so nothing cloud or native is required at startup.
   */
  memory: MemoryConfigSchema.default({
    semantic: { enabled: true, model: "local" },
    proactiveRecall: true,
    sessionDigest: true,
  }),
  /** Web search. Enabled by default and works KEYLESS (DuckDuckGo); a TinyFish
   * key (search.apiKey / $TINYFISH_API_KEY) is an optional higher-quality booster. */
  search: SearchConfigSchema.default({ enabled: true }),
  /** webfetch SSRF policy + limits. Private/loopback/metadata hosts blocked by default. */
  webfetch: WebfetchConfigSchema.default({
    allowPrivateHosts: false,
    allowHosts: [],
    timeoutMs: 8_000,
    maxBytes: 4_000_000,
  }),
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
  caching: z
    .object({
      enabled: z.boolean().default(true),
      /** Cache breakpoint on the tool block (schemas are large and stable). */
      cacheTools: z.boolean().default(true),
      /** Cache breakpoint on the trailing conversation prefix each turn. */
      cacheConversation: z.boolean().default(true),
    })
    .default({ enabled: true, cacheTools: true, cacheConversation: true }),
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
export type WebfetchConfig = z.infer<typeof WebfetchConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type HookConfig = z.infer<typeof HookSchema>;
export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
export type McpOAuth = z.infer<typeof McpOAuthSchema>;
