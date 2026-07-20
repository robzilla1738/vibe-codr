import { z } from "zod";
import {
  API_V1_CAPABILITIES,
  API_V1_COMMAND_TYPES,
  ApiV1AcceptedResponseSchema,
  ApiV1CommandSchema,
  ApiV1CursorSchema,
  ApiV1DecisionReceiptSchema,
  ApiV1DecisionRequestSchema,
  ApiV1SseFrameSchema,
} from "./api-v1.ts";
import { EngineSnapshotSchema } from "./domain.ts";

const exact = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const sessionId = z.string().min(1).max(256);

export const ACP_VIBE_METHODS = Object.freeze({
  capabilities: "vibe/capabilities",
  command: "vibe/command",
  decision: "vibe/decision",
  snapshot: "vibe/snapshot",
  replay: "vibe/replay",
} as const);

export const VibeAcpCapabilitiesRequestSchema = exact({});
export const VibeAcpCapabilitiesResponseSchema = exact({
  apiVersion: z.literal(1),
  transport: z.literal("acp-stdio"),
  capabilities: z.array(z.enum(API_V1_CAPABILITIES)).max(16),
  commandTypes: z.array(z.enum(API_V1_COMMAND_TYPES)).max(16),
  replay: z.literal("cursor"),
  decisions: z.literal("idempotent"),
});
export type VibeAcpCapabilitiesResponse = z.infer<typeof VibeAcpCapabilitiesResponseSchema>;

export const VibeAcpCommandRequestSchema = exact({
  sessionId,
  command: ApiV1CommandSchema,
});
export const VibeAcpCommandResponseSchema = ApiV1AcceptedResponseSchema;

export const VibeAcpDecisionRequestSchema = exact({
  sessionId,
  request: ApiV1DecisionRequestSchema,
});
export const VibeAcpDecisionResponseSchema = ApiV1DecisionReceiptSchema;

export const VibeAcpSnapshotRequestSchema = exact({ sessionId });
export const VibeAcpSnapshotResponseSchema = exact({ snapshot: EngineSnapshotSchema });

export const VibeAcpReplayRequestSchema = exact({
  sessionId,
  cursor: ApiV1CursorSchema.optional(),
});
export const VibeAcpReplayResponseSchema = exact({
  frames: z.array(ApiV1SseFrameSchema).max(1_025),
});

export type VibeAcpCommandRequest = z.infer<typeof VibeAcpCommandRequestSchema>;
export type VibeAcpDecisionRequest = z.infer<typeof VibeAcpDecisionRequestSchema>;
export type VibeAcpReplayRequest = z.infer<typeof VibeAcpReplayRequestSchema>;
