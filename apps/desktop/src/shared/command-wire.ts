import type { EngineCommand } from "@vibe/protocol/domain";

/** Safely below the host's one-million-character inbound line ceiling. */
export const HOST_INBOUND_SAFE_BYTES = 900_000;

export function encodedEngineCommandBytes(command: EngineCommand): number {
  const line = `${JSON.stringify({ op: "send", command })}\n`;
  return new TextEncoder().encode(line).byteLength;
}
