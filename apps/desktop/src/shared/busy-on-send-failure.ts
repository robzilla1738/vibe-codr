import type { EngineCommand } from "./commands";
import { commandsExpectBusy } from "./command-busy";

/**
 * Whether a failed `send` should clear chrome busy.
 *
 * AGENTS hard rule: busy clears only on `engine-idle` (or intentional failure
 * of an optimistic turn-start). Incidental command failures mid-turn
 * (density, steer, mode, permission, abort) must not mark the shell idle
 * while the host is still working.
 *
 * - If we optimistically set busy for this batch (`commandsExpectBusy`), clear
 *   on failure so a dead host does not stick Stop forever.
 * - If chrome was already busy (mid-turn), never clear on incidental failure.
 * - If not busy and not a turn-start, leave busy alone (no-op clear).
 */
export function shouldClearBusyOnSendFailure(
  commands: readonly EngineCommand[],
  alreadyBusy: boolean,
): boolean {
  if (alreadyBusy && !commandsExpectBusy(commands)) return false;
  if (commandsExpectBusy(commands)) return true;
  // Not a turn-start and not already busy — clearing is harmless no-op, but
  // prefer not to dispatch set-busy false noise.
  return false;
}
