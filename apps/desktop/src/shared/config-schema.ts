/**
 * Vibe-codr config schema mirror for the Electron shell.
 *
 * The authoritative schema lives in `@vibe/config` (vibe-codr/packages/config).
 * This module mirrors the STRUCTURE the settings UI needs to read and write —
 * every field here maps 1:1 to a key in the engine's `config.json`. The Electron
 * main process reads/writes the JSON files directly; the engine picks up changes
 * on the next bootstrap (or via live `run-slash` commands for the subset that
 * supports them).
 *
 * Fields are optional (the engine applies defaults for missing keys), so a
 * partial config object is always valid for a merge-patch write.
 */

// ── Sub-schemas ──────────────────────────────────────────────────────────

export interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  transport?: "openai-compatible" | "openai-responses";
  models?: string[];
  tokenFile?: string;
  tokenPath?: string;
  headers?: Record<string, string>;
}

export interface PermissionRule {
  tool: string;
  match?: string;
  matchExact?: string;
  action: "allow" | "deny" | "ask";
}

export interface SearchConfig {
  enabled?: boolean;
  apiKey?: string;
}

export interface WebfetchConfig {
  allowPrivateHosts?: boolean;
  allowHosts?: string[];
  timeoutMs?: number;
  maxBytes?: number;
}

export interface MemoryConfig {
  semantic?: { enabled?: boolean; model?: string };
  proactiveRecall?: boolean;
  sessionDigest?: boolean;
}

export interface HookConfig {
  event:
    | "session.start"
    | "user.prompt.submit"
    | "tool.before.execute"
    | "tool.after.execute"
    | "step.finish"
    | "assistant.message"
    | "session.idle"
    | "session.end"
    | "subagent.start"
    | "subagent.stop"
    | "permission.denied"
    | "compact.before"
    | "compact.after"
    | "goal.transition"
    | "turn.failure";
  matcher?: string;
  command?: string;
  url?: string;
  async?: boolean;
}

export interface ModelPrice {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface McpOAuth {
  scopes?: string[];
  clientId?: string;
  clientName?: string;
  redirectUri?: string;
  tokenStore?: string;
}

export type McpServerConfig =
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      enabled?: boolean;
      timeoutMs?: number;
    }
  | {
      url: string;
      transport?: "http" | "sse";
      headers?: Record<string, string>;
      oauth?: McpOAuth;
      enabled?: boolean;
      timeoutMs?: number;
    };

export interface LspServerConfig {
  command?: string;
  args?: string[];
  enabled?: boolean;
}

export interface LspConfig {
  enabled?: boolean;
  timeoutMs?: number;
  idleShutdownMs?: number;
  disabledLanguages?: string[];
  servers?: Record<string, LspServerConfig>;
}

export interface VisionRelayConfig {
  enabled?: boolean;
  relayModel?: string;
  timeoutMs?: number;
  maxCaptionChars?: number;
}

// ── Full config shape (all optional — partial writes are valid) ──────────

export interface VibeConfig {
  model?: string;
  planModel?: string;
  modelFallbacks?: string[];
  mode?: "plan" | "execute";
  maxSteps?: number;
  streamIdleTimeoutMs?: number;
  itemTimeoutMs?: number;
  providers?: Record<string, ProviderConfig>;
  permissions?: PermissionRule[];
  sandbox?: {
    mode?: "off" | "read-only" | "workspace-write";
    network?: "on" | "off";
    writablePaths?: string[];
  };
  approvalMode?: "ask" | "auto";
  security?: { trustProjectConfig?: boolean };
  theme?: string;
  accentColor?: string;
  details?: "quiet" | "normal" | "verbose";
  mouse?: boolean;
  plugins?: string[];
  toolDiscovery?: { mode?: "auto" | "direct"; directTools?: string[] };
  hooks?: HookConfig[];
  subagent?: {
    maxDepth?: number;
    maxParallel?: number;
    maxTotal?: number;
    providerConcurrency?: number;
    timeoutMs?: number;
    verifyMaxAttempts?: number;
    retainCompleted?: number;
    structuredMaxAttempts?: number;
    maxDetached?: number;
    model?: string;
  };
  orchestration?: { enabled?: boolean };
  goal?: { maxRounds?: number; planFirst?: boolean };
  loop?: { defaultMax?: number; maxUntilEvalFailures?: number };
  plan?: {
    minCodeTouches?: number;
    requireWebFetch?: boolean;
    requirePackageInfo?: boolean;
    allowUngrounded?: boolean;
    maxRejections?: number;
  };
  build?: {
    enabled?: boolean;
    visualVerify?: boolean;
    recon?: { enabled?: boolean; ledger?: boolean };
    gate?: {
      enabled?: boolean;
      maxRounds?: number;
      checks?: ("build" | "typecheck" | "test" | "lint")[];
      timeoutSec?: number;
    };
    commit?: { mode?: "checkpoint" | "branch" | "off"; branchPrefix?: string };
    review?: { enabled?: boolean; maxRounds?: number; stubScan?: boolean };
    worktrees?: { enabled?: boolean };
    ensemble?: { n?: number };
    models?: { cheap?: string; strong?: string };
  };
  lsp?: LspConfig;
  compaction?: {
    threshold?: number;
    offload?: {
      enabled?: boolean;
      threshold?: number;
      maxResultBytes?: number;
      previewBytes?: number;
      keepLiveResults?: number;
      maxArtifactBytes?: number;
    };
  };
  memory?: MemoryConfig;
  search?: SearchConfig;
  webfetch?: WebfetchConfig;
  checkpoints?: { enabled?: boolean };
  mcp?: { servers?: Record<string, McpServerConfig> };
  verify?: { command?: string; auto?: boolean; maxRetries?: number };
  pricing?: Record<string, ModelPrice>;
  contextWindow?: Record<string, number>;
  reasoning?: { effort?: "low" | "medium" | "high"; budgetTokens?: number };
  caching?: { enabled?: boolean; cacheTools?: boolean; cacheConversation?: boolean };
  latency?: { providerTier?: "default" | "priority" };
  budget?: { limitUSD?: number; onExceed?: "warn" | "stop" };
  retry?: { maxAttempts?: number; baseDelayMs?: number };
  vision?: { relay?: VisionRelayConfig };
  update?: { check?: boolean };
}

// ── Config file locations ────────────────────────────────────────────────

export type ConfigScope = "global" | "project";

export interface ConfigReadResult {
  ok: true;
  config: VibeConfig;
  path: string;
  raw: string;
}

export interface ConfigWriteRequest {
  scope: ConfigScope;
  cwd?: string;
  /** Deep-merge patch. A `null` value deletes that key. */
  patch: Record<string, unknown>;
}

export interface MemoryFileRequest {
  scope: ConfigScope;
  cwd?: string;
}

export interface MemoryFileResult {
  ok: true;
  path: string;
  content: string;
  exists: boolean;
}

export interface MemoryWriteRequest {
  scope: ConfigScope;
  cwd?: string;
  content: string;
}

// ── Config section metadata for the settings UI ──────────────────────────

export interface ConfigSectionMeta {
  id: string;
  label: string;
  description: string;
}

export const CONFIG_SECTIONS: readonly ConfigSectionMeta[] = [
  { id: "models", label: "Models", description: "Choose the default model and optional routing" },
  { id: "providers", label: "Providers", description: "Subscriptions, API keys, and custom endpoints" },
  { id: "mcp", label: "MCP Servers", description: "Model Context Protocol server connections" },
  { id: "permissions", label: "Permissions", description: "Tool allow/deny/ask rules" },
  { id: "appearance", label: "Appearance", description: "Theme, accent, density, mouse" },
  { id: "behavior", label: "Behavior", description: "Mode, approvals, max steps, sandbox" },
  { id: "subagents", label: "Subagents", description: "Depth, parallelism, timeouts, model tiers" },
  { id: "build", label: "Build & Verify", description: "Gate, checks, review, commit strategy" },
  { id: "memory", label: "Memory", description: "Semantic recall, session digest, proactive injection" },
  { id: "search", label: "Search & Web", description: "Web search, webfetch SSRF policy" },
  { id: "compaction", label: "Compaction", description: "Context thresholds and offload" },
  { id: "budget", label: "Budget & Retry", description: "Spend limits and retry policy" },
  { id: "hooks", label: "Hooks", description: "Lifecycle hooks (shell/HTTP)" },
  { id: "instructions", label: "Custom Instructions", description: "VIBE.md project and global memory" },
  { id: "advanced", label: "Runtime", description: "Plugins, LSP, caching, vision relay, updates" },
] as const;
