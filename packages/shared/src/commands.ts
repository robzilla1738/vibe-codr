import type { Mode, EngineSnapshot } from "./types.ts";
import type { UIEvent } from "./events.ts";

/**
 * Commands sent from a UI (TUI or CLI) into the engine. This is the only way
 * the UI mutates engine state — keeping the boundary one-directional and typed.
 */
export type EngineCommand =
  | { type: "submit-prompt"; text: string }
  | { type: "run-slash"; name: string; args: string }
  | { type: "set-mode"; mode: Mode }
  | { type: "set-model"; model: string }
  | { type: "set-goal"; goal: string | null }
  | { type: "abort" }
  | { type: "compact" }
  | {
      type: "resolve-permission";
      id: string;
      decision: "once" | "always" | "deny";
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
}
