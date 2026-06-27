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
  /** True while a turn is in flight. */
  busy: boolean;
}
