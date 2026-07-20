import type {
  AgentInfo,
  EngineCommand,
  EngineSnapshot,
  ModelSummary,
  ProviderInfo,
  SkillInfo,
  UIEvent,
} from "@vibe/protocol";

export type { EngineCommand, EngineCommandType } from "@vibe/protocol";

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
  /** Available skills (name + description), for the `/skills` menu. Optional. */
  listSkills?(): SkillInfo[] | Promise<SkillInfo[]>;
  /** Flush the session digest + tear down (idempotent). A UI should await this
   * before a hard `process.exit` so an in-flight digest completes. Optional so a
   * minimal/mock client can omit it. */
  finalize?(): Promise<void>;
}
