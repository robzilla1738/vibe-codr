import type {
  AgentInfo,
  EngineCommand,
  EngineSnapshot,
  ModelSummary,
  ProviderInfo,
  SkillInfo,
  UIEvent,
} from "@vibe/protocol";

/** One-release compatibility facade for existing renderer/mobile imports. */
export type { EngineCommand, EngineCommandType } from "@vibe/protocol";

/**
 * The UI-facing client interface remains presentation-shell specific. Its wire
 * values are all canonical @vibe/protocol types.
 */
export interface EngineClient {
  events(): AsyncIterable<UIEvent>;
  send(command: EngineCommand): Promise<void> | void;
  snapshot(): EngineSnapshot;
  listModels(): Promise<ModelSummary[]>;
  listProviders?(): ProviderInfo[] | Promise<ProviderInfo[]>;
  listAgents?(): AgentInfo[] | Promise<AgentInfo[]>;
  listSkills?(): SkillInfo[] | Promise<SkillInfo[]>;
  finalize?(): Promise<void>;
}
