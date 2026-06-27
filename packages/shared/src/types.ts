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

/** Static, read-only snapshot of engine state for the UI to render. */
export interface EngineSnapshot {
  sessionId: string;
  model: string;
  mode: Mode;
  goal: string | null;
  history: Message[];
  /** The agent's current working task list (may be empty). */
  tasks: Task[];
  /** True while a turn is in flight. */
  busy: boolean;
}
