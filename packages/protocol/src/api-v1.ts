import { z } from "zod";
import { EngineSnapshotSchema, ModeSchema, UIEventSchema } from "./domain.ts";
import { JsonValueSchema } from "./runtime-error.ts";

export const API_V1_LIMITS = Object.freeze({
  headerBytes: 32 * 1024,
  bodyBytes: 64 * 1024,
  connections: 64,
  sseConnections: 16,
  replayFrames: 1_024,
  replayBytes: 1024 * 1024,
  idleSeconds: 30,
  text: 32 * 1024,
  id: 256,
  idempotencyKey: 256,
} as const);

const id = z
  .string()
  .min(1)
  .max(API_V1_LIMITS.id)
  .regex(/^[A-Za-z0-9._:-]+$/);
const text = z.string().max(API_V1_LIMITS.text);
const exact = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const ApiV1EmptyRequestSchema = exact({});

export const ApiV1CursorSchema = exact({
  epoch: id,
  sequence: z.number().int().nonnegative().safe(),
});
export type ApiV1Cursor = z.infer<typeof ApiV1CursorSchema>;

export function encodeApiV1Cursor(cursor: ApiV1Cursor): string {
  const parsed = ApiV1CursorSchema.parse(cursor);
  return `${parsed.epoch}:${parsed.sequence}`;
}

export function decodeApiV1Cursor(value: string | null | undefined): ApiV1Cursor | undefined {
  if (!value) return undefined;
  const colon = value.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const sequenceText = value.slice(colon + 1);
  if (!/^\d+$/.test(sequenceText)) return undefined;
  const parsed = ApiV1CursorSchema.safeParse({
    epoch: value.slice(0, colon),
    sequence: Number(sequenceText),
  });
  return parsed.success ? parsed.data : undefined;
}

export const ApiV1ErrorSchema = exact({
  error: exact({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2_048),
    retryable: z.boolean(),
    details: z.record(z.string(), JsonValueSchema).optional(),
  }),
});
export type ApiV1Error = z.infer<typeof ApiV1ErrorSchema>;

export const ApiV1CapabilitiesResponseSchema = exact({
  apiVersion: z.literal(1),
  workspace: z.string().min(1).max(4_096),
  transport: z.literal("loopback"),
  events: z.literal("authenticated-sse"),
  capabilities: z
    .array(
      z.enum([
        "sessions:list",
        "sessions:create",
        "sessions:get",
        "sessions:prompt",
        "sessions:command",
        "sessions:fork",
        "sessions:decision",
        "sessions:events",
        "sessions:archive",
        "sessions:delete",
      ]),
    )
    .max(16),
  commandTypes: z
    .array(
      z.enum([
        "abort",
        "compact",
        "set-mode",
        "set-approvals",
        "set-model",
        "set-goal",
        "run-slash",
      ]),
    )
    .max(16),
});
export type ApiV1CapabilitiesResponse = z.infer<typeof ApiV1CapabilitiesResponseSchema>;

export const ApiV1SessionSchema = exact({
  id,
  model: z.string().min(1).max(1_024),
  mode: ModeSchema,
  goal: text.nullable(),
  title: z.string().max(120).optional(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  active: z.boolean(),
  forkedFrom: exact({ sessionId: id, turnId: id }).optional(),
  parentSessionId: id.optional(),
  forkedAtTurnId: id.optional(),
});
export type ApiV1Session = z.infer<typeof ApiV1SessionSchema>;

export const ApiV1ListSessionsResponseSchema = exact({
  sessions: z.array(ApiV1SessionSchema).max(10_000),
});
export type ApiV1ListSessionsResponse = z.infer<typeof ApiV1ListSessionsResponseSchema>;

export const ApiV1CreateSessionRequestSchema = exact({
  model: z.string().min(1).max(1_024).optional(),
  mode: ModeSchema.optional(),
});
export type ApiV1CreateSessionRequest = z.infer<typeof ApiV1CreateSessionRequestSchema>;

export const ApiV1SessionResponseSchema = exact({
  session: ApiV1SessionSchema,
  snapshot: EngineSnapshotSchema,
});
export type ApiV1SessionResponse = z.infer<typeof ApiV1SessionResponseSchema>;

export const ApiV1GetSessionResponseSchema = exact({
  session: ApiV1SessionSchema,
  snapshot: EngineSnapshotSchema.optional(),
});
export type ApiV1GetSessionResponse = z.infer<typeof ApiV1GetSessionResponseSchema>;

export const ApiV1PromptRequestSchema = exact({ text: z.string().min(1).max(API_V1_LIMITS.text) });
export type ApiV1PromptRequest = z.infer<typeof ApiV1PromptRequestSchema>;

export const ApiV1CommandSchema = z.discriminatedUnion("type", [
  exact({ type: z.literal("abort") }),
  exact({ type: z.literal("compact") }),
  exact({ type: z.literal("set-mode"), mode: ModeSchema, start: z.boolean().optional() }),
  exact({ type: z.literal("set-approvals"), mode: z.enum(["ask", "auto"]) }),
  exact({ type: z.literal("set-model"), model: z.string().min(1).max(1_024) }),
  exact({ type: z.literal("set-goal"), goal: text.nullable() }),
  exact({
    type: z.literal("run-slash"),
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9-]+$/),
    args: text,
  }),
]);
export type ApiV1Command = z.infer<typeof ApiV1CommandSchema>;

export const ApiV1CommandRequestSchema = exact({ command: ApiV1CommandSchema });
export type ApiV1CommandRequest = z.infer<typeof ApiV1CommandRequestSchema>;

export const ApiV1AcceptedResponseSchema = exact({ accepted: z.literal(true) });
export type ApiV1AcceptedResponse = z.infer<typeof ApiV1AcceptedResponseSchema>;

export const ApiV1ForkRequestSchema = exact({ atTurnId: id });
export type ApiV1ForkRequest = z.infer<typeof ApiV1ForkRequestSchema>;

export const ApiV1ForkResponseSchema = exact({ session: ApiV1SessionSchema });
export type ApiV1ForkResponse = z.infer<typeof ApiV1ForkResponseSchema>;

const permissionDecision = exact({
  kind: z.literal("permission"),
  id,
  decision: z.enum(["once", "always", "always-project", "deny"]),
  feedback: text.optional(),
});
const planDecision = exact({
  kind: z.literal("plan"),
  id,
  decision: z.enum(["accept", "edit", "keep-planning"]),
  edit: text.optional(),
  approvals: z.literal("auto").optional(),
});
const questionDecision = exact({
  kind: z.literal("question"),
  id,
  answers: z.array(text).max(64),
  freeform: text.optional(),
});
const externalDecision = exact({
  kind: z.literal("external-capability"),
  id,
  decision: z.enum(["approve", "deny"]),
  result: JsonValueSchema.optional(),
  error: text.optional(),
});

export const ApiV1DecisionSchema = z.discriminatedUnion("kind", [
  permissionDecision,
  planDecision,
  questionDecision,
  externalDecision,
]);
export type ApiV1Decision = z.infer<typeof ApiV1DecisionSchema>;

export const ApiV1DecisionRequestSchema = exact({
  idempotencyKey: z.string().min(1).max(API_V1_LIMITS.idempotencyKey),
  decision: ApiV1DecisionSchema,
});
export type ApiV1DecisionRequest = z.infer<typeof ApiV1DecisionRequestSchema>;

export const ApiV1DecisionReceiptSchema = exact({
  receiptId: id,
  idempotencyKey: z.string().min(1).max(API_V1_LIMITS.idempotencyKey),
  sessionId: id,
  pendingId: id,
  acceptedAt: z.number().finite().nonnegative(),
});
export type ApiV1DecisionReceipt = z.infer<typeof ApiV1DecisionReceiptSchema>;

export const ApiV1MutationResponseSchema = exact({ id, ok: z.literal(true) });
export type ApiV1MutationResponse = z.infer<typeof ApiV1MutationResponseSchema>;

export const ApiV1SseReadySchema = exact({
  type: z.literal("ready"),
  cursor: ApiV1CursorSchema,
  truncated: z.boolean(),
  snapshot: EngineSnapshotSchema.optional(),
});
export const ApiV1SseEventSchema = exact({
  type: z.literal("event"),
  cursor: ApiV1CursorSchema,
  event: UIEventSchema,
  pendingDecisionId: id.optional(),
});
export const ApiV1SseFrameSchema = z.discriminatedUnion("type", [
  ApiV1SseReadySchema,
  ApiV1SseEventSchema,
]);
export type ApiV1SseFrame = z.infer<typeof ApiV1SseFrameSchema>;

export const API_V1_CAPABILITIES = Object.freeze([
  "sessions:list",
  "sessions:create",
  "sessions:get",
  "sessions:prompt",
  "sessions:command",
  "sessions:fork",
  "sessions:decision",
  "sessions:events",
  "sessions:archive",
  "sessions:delete",
] as const);

export const API_V1_COMMAND_TYPES = Object.freeze([
  "abort",
  "compact",
  "set-mode",
  "set-approvals",
  "set-model",
  "set-goal",
  "run-slash",
] as const);
