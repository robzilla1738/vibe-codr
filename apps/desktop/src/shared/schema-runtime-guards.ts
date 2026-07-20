import { EngineSnapshotSchema, UIEventSchema, type EngineSnapshot, type UIEvent } from "@vibe/protocol/domain";

/** Main-process validation reuses the Zod graph already required by host decoding. */
export function isSchemaEngineSnapshot(value: unknown): value is EngineSnapshot {
  return EngineSnapshotSchema.safeParse(value).success;
}

export function isSchemaUIEvent(value: unknown): value is UIEvent {
  return UIEventSchema.safeParse(value).success;
}
