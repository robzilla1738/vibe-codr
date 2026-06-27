import type { Mode, QueuedItem, SessionUsage, Task, Usage } from "./types.ts";

/**
 * Events emitted by the engine and consumed by any UI (TUI, headless printer).
 * The engine translates AI-SDK stream parts into these so the UI never depends
 * on the AI SDK. `subagentId` is set when the event originates from a subagent.
 */
export type UIEvent =
  | { type: "session-start"; sessionId: string; model: string; mode: Mode }
  | { type: "user-message"; sessionId: string; text: string }
  | {
      type: "assistant-text-delta";
      sessionId: string;
      subagentId?: string;
      delta: string;
    }
  | {
      type: "reasoning-delta";
      sessionId: string;
      subagentId?: string;
      delta: string;
    }
  | {
      type: "tool-call-started";
      sessionId: string;
      subagentId?: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool-call-progress";
      sessionId: string;
      toolCallId: string;
      chunk: string;
    }
  | {
      type: "tool-call-finished";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    }
  | { type: "step-finished"; sessionId: string; usage?: Usage }
  | { type: "usage-updated"; sessionId: string; usage: SessionUsage }
  | { type: "mode-changed"; sessionId: string; mode: Mode }
  | { type: "model-changed"; sessionId: string; model: string }
  | { type: "goal-changed"; sessionId: string; goal: string | null }
  | { type: "plan-presented"; sessionId: string; plan: string }
  | {
      type: "permission-request";
      sessionId: string;
      id: string;
      toolName: string;
      input: unknown;
    }
  | { type: "tasks-updated"; sessionId: string; tasks: Task[] }
  | {
      type: "queue-changed";
      /** Item currently running, if any. */
      active: QueuedItem | null;
      /** Items waiting to run, in order. */
      pending: QueuedItem[];
    }
  | { type: "compacted"; sessionId: string; freedTokens: number }
  | { type: "subagent-started"; sessionId: string; subagentId: string; prompt: string }
  | { type: "subagent-finished"; sessionId: string; subagentId: string; result: string }
  | { type: "loop-tick"; loopId: string; iteration: number }
  | { type: "loop-stopped"; loopId: string; reason: string }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string }
  | { type: "engine-error"; sessionId?: string; message: string }
  | { type: "turn-finished"; sessionId: string }
  | { type: "session-idle"; sessionId: string };

export type UIEventType = UIEvent["type"];
