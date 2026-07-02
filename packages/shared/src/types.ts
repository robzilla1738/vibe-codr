/**
 * Core domain types shared across every vibe-codr package.
 * This module is intentionally dependency-light (only `zod`) so it can sit at
 * the bottom of the dependency graph with everything depending inward on it.
 */

/** Agent operating mode. `plan` is read-only; `execute` permits side effects. */
export type Mode = "plan" | "execute";

/** Message author role. */
export type Role = "user" | "assistant" | "system" | "tool";

/** A single content part within a message. */
export type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError?: boolean;
    };

/** Lifecycle of a single task in the agent's working task list. */
export type TaskStatus = "pending" | "in_progress" | "completed";

/**
 * One entry in the agent's task list — the live checklist it maintains while
 * working through a multi-step request (the `update_tasks` tool drives it).
 */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
}

/**
 * A model the UI can offer in the interactive `/model` picker. A deliberately
 * minimal projection of the providers' richer `ModelInfo` so this base package
 * stays free of any provider-layer dependency.
 */
export interface ModelSummary {
  /** Bare model id within its provider (e.g. `gpt-5.5`, `glm-5.2`). */
  id: string;
  /** Provider id (e.g. `openai`, `ollama`); `${providerId}/${id}` is the full id. */
  providerId: string;
  /** Human label, when the provider supplies one. */
  name?: string;
  /** Context window in tokens, when known. */
  contextWindow?: number;
}

/** A provider the UI can offer in the `/providers` menu — its id, whether it has
 * usable credentials (or is keyless), and the env var(s) that supply its key. */
export interface ProviderInfo {
  /** Provider id (e.g. `openai`, `anthropic`, `ollama`). */
  id: string;
  /** Has a usable key (env / config / token file) or is keyless. */
  configured: boolean;
  /** Needs no key (e.g. a local endpoint). */
  keyless: boolean;
  /** The env var name(s) that supply this provider's key (for the "set a key" hint). */
  env: string[];
}

/** A named subagent the UI can list/configure in the `/agents` menu. */
export interface AgentInfo {
  name: string;
  description: string;
  /** Its configured model, or null when it inherits the subagent/main model. */
  model: string | null;
  /** Its default run mode. */
  mode: Mode;
}

/** A prompt or command waiting in (or running at the head of) the engine queue. */
export interface QueuedItem {
  id: string;
  /** Short human label (truncated prompt text or `/command`). */
  label: string;
}

/** Token usage for a single assistant turn. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Input tokens served from the provider's prompt cache (subset of input). */
  cachedInputTokens?: number;
}

/** Cumulative token usage and estimated cost for a session. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated cost in USD (0 when no price is known for the model). */
  costUSD: number;
  /** True when `costUSD` is based on an estimated (base-model fallback) price. */
  costEstimated?: boolean;
  /** Cumulative input tokens served from the prompt cache, if reported. */
  cachedInputTokens?: number;
}

/** A persisted conversation message. */
export interface Message {
  id: string;
  role: Role;
  parts: Part[];
  createdAt: number;
  usage?: Usage;
  /** Subagent that produced this message, if any. */
  subagentId?: string;
  metadata?: Record<string, unknown>;
}

/** Working-tree git state surfaced in the header's git context. */
export interface GitInfo {
  branch: string;
  /** Number of changed working-tree entries (`git status --porcelain`). */
  dirty: number;
  /** Commits ahead/behind the upstream (0 when none/no upstream). */
  ahead: number;
  behind: number;
  /** True when running inside a linked worktree (not the main checkout). */
  worktree: boolean;
}

/** A background shell job (started with `bash background:true`), surfaced in the
 * `/jobs` sub-view so you can see long-running commands and dev servers. */
export interface JobInfo {
  id: string;
  command: string;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
  /** OS process id of the `bash -lc` child (for reference). */
  pid?: number;
  /** Localhost server URLs detected in the job's output (e.g. http://localhost:3000). */
  servers: string[];
  /** Trailing lines of captured output, for the sub-view detail. */
  outputTail: string;
}

/** Static, read-only snapshot of engine state for the UI to render. */
export interface EngineSnapshot {
  sessionId: string;
  model: string;
  mode: Mode;
  goal: string | null;
  history: Message[];
  /** The agent's current working task list (may be empty). */
  tasks: Task[];
  /** Cumulative token usage + cost for the session. */
  usage: SessionUsage;
  /** True while a turn is in flight. */
  busy: boolean;
  /** Active UI theme name. */
  theme: string;
  /** Accent hue (hex) for UI chrome. */
  accentColor: string;
  /** Default approval handling for side-effecting tools. */
  approvalMode: "ask" | "auto";
  /** All invocable slash names (built-in + custom commands + skills), for the
   * input's "recognized command" cue. */
  commandNames: string[];
  /** Dedicated subagent model (full `provider/id`), or undefined when subagents
   * inherit the main model. Lets the picker mark the current subagent choice. */
  subagentModel?: string;
  /** Current reasoning effort (low|medium|high), or undefined for the provider
   * default. Lets the `/reasoning` toggle mark the current value. */
  reasoning?: string;
  /** Working-tree git state, when in a repo. */
  git?: GitInfo;
}
