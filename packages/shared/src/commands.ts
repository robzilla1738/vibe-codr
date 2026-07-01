import type { Mode, EngineSnapshot, ModelSummary, ProviderInfo, AgentInfo } from "./types.ts";
import type { UIEvent } from "./events.ts";

/**
 * Commands sent from a UI (TUI or CLI) into the engine. This is the only way
 * the UI mutates engine state — keeping the boundary one-directional and typed.
 */
export type EngineCommand =
  | { type: "submit-prompt"; text: string }
  | { type: "run-slash"; name: string; args: string }
  | { type: "set-mode"; mode: Mode }
  | { type: "set-approvals"; mode: "ask" | "auto" }
  | { type: "set-model"; model: string }
  // Set (or, with `null`, clear → inherit main) the dedicated subagent model.
  | { type: "set-subagent-model"; model: string | null }
  // Set (or, with `null`, clear → inherit) a NAMED agent's model; persists to
  // `.vibe/agents/<name>.md`.
  | { type: "set-agent-model"; name: string; model: string | null }
  // Scaffold a new named subagent file (`.vibe/agents/<name>.md`) to edit.
  | { type: "create-agent"; name: string }
  | { type: "set-goal"; goal: string | null }
  | { type: "abort" }
  // Drop one queued (waiting) prompt without running it.
  | { type: "dequeue"; id: string }
  // "Steer": jump a queued prompt to the front and interrupt the running turn so
  // it runs next — redirect the agent now instead of waiting for the queue.
  | { type: "steer"; id: string }
  | { type: "compact" }
  | {
      type: "resolve-permission";
      id: string;
      decision: "once" | "always" | "deny";
    }
  // Resolve a presented plan: accept → switch to execute + start against the plan;
  // edit → re-plan with the feedback text; keep-planning → dismiss, stay in plan.
  | {
      type: "resolve-plan";
      decision: "accept" | "edit" | "keep-planning";
      edit?: string;
    }
  | { type: "shutdown" };

export type EngineCommandType = EngineCommand["type"];

/**
 * The contract a UI uses to talk to the engine. The engine implementation
 * lives in `@vibe/core`; the TUI in `@vibe/tui` depends only on this shape.
 */
export interface EngineClient {
  /** Async stream of UI events; iterate until the engine shuts down. */
  events(): AsyncIterable<UIEvent>;
  /** Dispatch a command. May resolve once the command is accepted (not done). */
  send(command: EngineCommand): Promise<void> | void;
  /** Current static state, for first paint and resync. */
  snapshot(): EngineSnapshot;
  /** Models across the configured providers, for the interactive `/model` picker. */
  listModels(): Promise<ModelSummary[]>;
  /** All known providers + whether each is configured, for the `/providers` menu.
   * Optional so a minimal client (tests) can omit it. */
  listProviders?(): ProviderInfo[] | Promise<ProviderInfo[]>;
  /** Named subagents + their model/mode, for the `/agents` menu. Optional. */
  listAgents?(): AgentInfo[] | Promise<AgentInfo[]>;
  /** Flush the session digest + tear down (idempotent). A UI should await this
   * before a hard `process.exit` so an in-flight digest completes. Optional so a
   * minimal/mock client can omit it. */
  finalize?(): Promise<void>;
}
