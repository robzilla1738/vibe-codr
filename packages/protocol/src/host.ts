import { z } from "zod";
import {
  AgentInfoSchema,
  EngineCommandSchema,
  EngineSnapshotSchema,
  ExecutionTargetSchema,
  HandoffPreparationSchema,
  ModelSummarySchema,
  PortableSessionArchiveV1Schema,
  ProviderInfoSchema,
  SkillInfoSchema,
  UIEventSchema,
} from "./domain.ts";

const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape);
const finite = z.number().finite();
const safeInteger = z.number().refine(Number.isSafeInteger, "expected a safe integer");
const positiveSafeInteger = safeInteger.refine((value) => value > 0, "expected a positive integer");
const nonNegativeSafeInteger = safeInteger.refine(
  (value) => value >= 0,
  "expected a non-negative integer",
);
const nonEmpty = z.string().min(1);

export const HOST_PROTOCOL_VERSION = 2 as const;
export const HOST_PROTOCOL_CAPABILITIES = ["event-replay"] as const;
export const HostProtocolCapabilitySchema = z.literal("event-replay");
export type HostProtocolCapability = z.infer<typeof HostProtocolCapabilitySchema>;

export const HostEventFrameSchema = loose({
  type: z.literal("event"),
  hostInstanceId: nonEmpty,
  seq: positiveSafeInteger,
  event: UIEventSchema,
});
export type HostEventFrame = z.infer<typeof HostEventFrameSchema>;

export const HostReplayResultSchema = loose({
  hostInstanceId: nonEmpty,
  events: z.array(HostEventFrameSchema),
  lastEventSeq: nonNegativeSafeInteger,
  truncated: z.boolean(),
});
export type HostReplayResult = z.infer<typeof HostReplayResultSchema>;

export const HostSnapshotSchema = EngineSnapshotSchema.extend({
  hostInstanceId: nonEmpty,
  lastEventSeq: nonNegativeSafeInteger,
});
export type HostSnapshot = z.infer<typeof HostSnapshotSchema>;

const runtimeProfileSchema = loose({
  schemaVersion: z.literal(1),
  theme: z.string().min(1).max(128),
  accentColor: z.string().max(128).optional(),
  details: z.enum(["quiet", "normal", "verbose"]),
});
const requiredModelsSchema = z
  .array(
    z
      .string()
      .max(512)
      .regex(/^[^/\s]+\/\S+$/),
  )
  .min(1)
  .max(32);
const runtimeCredentialsSchema = z
  .record(z.string(), z.string().min(1))
  .superRefine((value, ctx) => {
    const entries = Object.entries(value);
    if (entries.length > 64) ctx.addIssue({ code: "custom", message: "too many credentials" });
    let bytes = 0;
    for (const [name, credential] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        ctx.addIssue({ code: "custom", message: `invalid environment name ${name}` });
      }
      bytes += name.length + credential.length;
    }
    if (bytes > 256 * 1024)
      ctx.addIssue({ code: "custom", message: "credentials exceed size limit" });
  });

export const HostBootstrapSchema = loose({
  op: z.literal("bootstrap"),
  cwd: z.string().trim().min(1),
  resume: z.string().optional(),
  continue: z.boolean().optional(),
  model: z.string().optional(),
  mode: z.enum(["plan", "execute", "yolo"]).optional(),
  executionTarget: ExecutionTargetSchema.optional(),
  requiredModels: requiredModelsSchema.optional(),
  runtimeProfile: runtimeProfileSchema.optional(),
  runtimeCredentials: runtimeCredentialsSchema.optional(),
});
export type HostBootstrap = z.infer<typeof HostBootstrapSchema>;

const providerIdSchema = z.enum(["openai-codex", "xai-oauth"]);
const authMethodSchema = z.enum(["browser", "device"]);
const allRpcParamsShape = {
  cwd: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  sessionId: z.string().optional(),
  target: ExecutionTargetSchema.optional(),
  expectedGeneration: nonNegativeSafeInteger.optional(),
  ownershipGeneration: nonNegativeSafeInteger.optional(),
  nonce: z.string().optional(),
  engineRevision: z.string().optional(),
  archive: PortableSessionArchiveV1Schema.optional(),
  archivePath: z.string().optional(),
  provisional: z.boolean().optional(),
  providerId: providerIdSchema.optional(),
  authMethod: authMethodSchema.optional(),
  authSessionId: z.string().optional(),
  hostInstanceId: z.string().optional(),
  afterSeq: nonNegativeSafeInteger.optional(),
  query: z.string().optional(),
  limit: nonNegativeSafeInteger.optional(),
  atTurnId: z.string().optional(),
} as const;
export const HostRpcParamsSchema = z.object(allRpcParamsShape).strict();
export type HostRpcParams = z.infer<typeof HostRpcParamsSchema>;

const noParams = z.object({}).strict();
const params = <K extends keyof typeof allRpcParamsShape>(...keys: K[]) =>
  z
    .object(
      Object.fromEntries(keys.map((key) => [key, allRpcParamsShape[key]])) as Pick<
        typeof allRpcParamsShape,
        K
      >,
    )
    .strict();

export const ProjectSessionSummarySchema = loose({
  id: z.string(),
  title: z.string(),
  model: z.string(),
  mode: z.enum(["plan", "execute"]),
  goal: z.string().nullable(),
  createdAt: finite,
  updatedAt: finite,
  latestTurnId: z.string().optional(),
});
export type ProjectSessionSummary = z.infer<typeof ProjectSessionSummarySchema>;
export const SessionSearchHitSchema = loose({
  cwd: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  timestamp: finite,
  snippet: z.string(),
  score: finite,
});
export type SessionSearchHit = z.infer<typeof SessionSearchHitSchema>;
export const ProjectSummarySchema = loose({
  cwd: z.string(),
  name: z.string(),
  updatedAt: finite,
  sessions: z.array(ProjectSessionSummarySchema),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const SessionMetaSchema = loose({
  version: finite.optional(),
  id: z.string(),
  model: z.string(),
  mode: z.enum(["plan", "execute"]),
  goal: z.string().nullable(),
  kind: z.enum(["root", "subagent"]).optional(),
  parentSessionId: z.string().optional(),
  agentName: z.string().optional(),
  createdAt: finite,
  updatedAt: finite,
  title: z.string().optional(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const McpServerSummarySchema = loose({
  name: z.string(),
  connected: z.boolean(),
  toolCount: finite,
  resourceCount: finite,
  promptCount: finite,
  error: z.string().optional(),
  configured: z.boolean(),
});
export type McpServerSummary = z.infer<typeof McpServerSummarySchema>;

const contributionSchema = z.enum(["tools", "providers", "commands", "skills", "hooks"]);
export const PluginStatusSchema = loose({
  specifier: z.string(),
  name: z.string(),
  version: z.string().optional(),
  status: z.enum(["loaded", "degraded", "incompatible", "failed"]),
  reason: z.string().optional(),
  declaredContributions: z.array(contributionSchema),
  registeredContributions: z.record(contributionSchema, z.array(z.string())),
  provenance: loose({
    source: z.enum(["npm", "local"]),
    verified: z.boolean(),
    packageVersion: z.string().optional(),
    integrity: z.string().optional(),
  }),
});
export type PluginStatus = z.infer<typeof PluginStatusSchema>;

export const SubscriptionAuthStartSchema = loose({
  sessionId: z.string(),
  providerId: providerIdSchema,
  method: authMethodSchema,
  url: z.string(),
  userCode: z.string().optional(),
  expiresAt: finite,
});
export type SubscriptionAuthStart = z.infer<typeof SubscriptionAuthStartSchema>;
export const SubscriptionAuthStatusSchema = loose({
  sessionId: z.string().optional(),
  providerId: providerIdSchema,
  state: z.enum(["disconnected", "pending", "connected", "error", "cancelled"]),
  method: authMethodSchema.optional(),
  url: z.string().optional(),
  userCode: z.string().optional(),
  expiresAt: finite.optional(),
  accountLabel: z.string().optional(),
  error: z.string().optional(),
});
export type SubscriptionAuthStatus = z.infer<typeof SubscriptionAuthStatusSchema>;
export const ExportedProviderCredentialSchema = loose({
  providerId: providerIdSchema,
  access: z.string(),
  accountId: z.string().optional(),
}).nullable();
export type ExportedProviderCredential = z.infer<typeof ExportedProviderCredentialSchema>;

const nullResult = z.null();
const idResult = loose({ id: z.string() });
const cwdResult = loose({ cwd: z.string() });
const rpc = <P extends z.ZodType, R extends z.ZodType>(paramsSchema: P, result: R) => ({
  params: paramsSchema,
  result,
});

export const HOST_RPC_SCHEMAS = {
  snapshot: rpc(noParams, HostSnapshotSchema),
  replayEvents: rpc(params("hostInstanceId", "afterSeq"), HostReplayResultSchema),
  listModels: rpc(noParams, z.array(ModelSummarySchema)),
  listProviders: rpc(noParams, z.array(ProviderInfoSchema)),
  listAgents: rpc(noParams, z.array(AgentInfoSchema)),
  listSkills: rpc(noParams, z.array(SkillInfoSchema)),
  listMcp: rpc(noParams, z.array(McpServerSummarySchema)),
  listPluginStatus: rpc(noParams, z.array(PluginStatusSchema)),
  providerAuthStatus: rpc(params("providerId", "authSessionId"), SubscriptionAuthStatusSchema),
  beginProviderAuth: rpc(params("providerId", "authMethod"), SubscriptionAuthStartSchema),
  cancelProviderAuth: rpc(params("providerId", "authSessionId"), nullResult),
  logoutProviderAuth: rpc(params("providerId"), nullResult),
  exportProviderAuth: rpc(params("providerId"), ExportedProviderCredentialSchema),
  finalize: rpc(noParams, nullResult),
  listSessions: rpc(noParams, z.array(SessionMetaSchema)),
  searchSessions: rpc(params("cwd", "query", "limit"), z.array(SessionSearchHitSchema)),
  listProjects: rpc(noParams, z.array(ProjectSummarySchema)),
  renameProject: rpc(params("cwd", "name"), loose({ cwd: z.string(), name: z.string() })),
  archiveProject: rpc(params("cwd"), cwdResult),
  deleteProject: rpc(params("cwd"), cwdResult),
  renameSession: rpc(params("cwd", "id", "title"), loose({ id: z.string(), title: z.string() })),
  deleteSession: rpc(params("cwd", "id"), idResult),
  archiveSession: rpc(params("cwd", "id"), idResult),
  forkSession: rpc(
    params("cwd", "id", "atTurnId"),
    loose({ id: z.string(), cwd: z.string(), atTurnId: z.string() }),
  ),
  prepareHandoff: rpc(params("target", "expectedGeneration"), HandoffPreparationSchema),
  exportPortableSession: rpc(
    params("engineRevision", "ownershipGeneration"),
    PortableSessionArchiveV1Schema,
  ),
  importPortableSession: rpc(
    params("cwd", "archive", "archivePath", "engineRevision", "provisional"),
    loose({ sessionId: z.string() }),
  ),
  commitPortableImport: rpc(params("cwd", "sessionId", "ownershipGeneration"), nullResult),
  abortPortableImport: rpc(params("cwd", "sessionId", "ownershipGeneration"), nullResult),
  recoverLostCloudOwnership: rpc(
    params("cwd", "sessionId", "target", "expectedGeneration"),
    nonNegativeSafeInteger,
  ),
  abortInterruptedHandoff: rpc(
    params("cwd", "sessionId", "target", "expectedGeneration"),
    loose({
      outcome: z.enum(["aborted", "already-committed"]),
      generation: nonNegativeSafeInteger,
    }),
  ),
  commitHandoff: rpc(params("cwd", "sessionId", "nonce"), nullResult),
  abortHandoff: rpc(params("cwd", "sessionId", "nonce"), nullResult),
} as const;

export type RpcMethod = keyof typeof HOST_RPC_SCHEMAS;
export const RPC_METHODS = Object.freeze(Object.keys(HOST_RPC_SCHEMAS) as RpcMethod[]);
export type HostRpcMethodParams<M extends RpcMethod> = z.infer<
  (typeof HOST_RPC_SCHEMAS)[M]["params"]
>;
export type HostRpcMethodResult<M extends RpcMethod> = z.infer<
  (typeof HOST_RPC_SCHEMAS)[M]["result"]
>;
export type HostRpcRequest<M extends RpcMethod = RpcMethod> = {
  [K in M]: { op: "rpc"; id: number; method: K; params?: HostRpcMethodParams<K> };
}[M];

const genericRpcSchema = loose({
  op: z.literal("rpc"),
  id: positiveSafeInteger,
  method: z.enum(RPC_METHODS as [RpcMethod, ...RpcMethod[]]),
  params: HostRpcParamsSchema.optional(),
});
export const HostSendSchema = loose({
  op: z.literal("send"),
  command: EngineCommandSchema,
});
export const HostShutdownSchema = loose({ op: z.literal("shutdown") });
export const HostInboundSchema = z.union([
  HostBootstrapSchema,
  HostSendSchema,
  genericRpcSchema,
  HostShutdownSchema,
]);
export type HostInbound =
  | HostBootstrap
  | z.infer<typeof HostSendSchema>
  | HostRpcRequest
  | z.infer<typeof HostShutdownSchema>;

export const HostReadyFrameSchema = loose({
  type: z.literal("ready"),
  protocolVersion: z.literal(HOST_PROTOCOL_VERSION),
  engineRevision: nonEmpty,
  capabilities: z.tuple([HostProtocolCapabilitySchema]),
  hostInstanceId: nonEmpty,
  sessionId: nonEmpty,
});
export type HostReadyFrame = z.infer<typeof HostReadyFrameSchema>;
export const HostRpcSuccessSchema = loose({
  type: z.literal("resp"),
  id: positiveSafeInteger,
  ok: z.literal(true),
  value: z.unknown(),
});
export const HostRpcErrorSchema = loose({
  type: z.literal("resp"),
  id: positiveSafeInteger,
  ok: z.literal(false),
  error: z.string(),
});
export type HostRpcError = z.infer<typeof HostRpcErrorSchema>;
export const HostFatalErrorSchema = loose({ type: z.literal("fatal"), message: z.string() });
export type HostFatalError = z.infer<typeof HostFatalErrorSchema>;
export const HostOutboundSchema = z.union([
  HostReadyFrameSchema,
  HostEventFrameSchema,
  HostRpcSuccessSchema,
  HostRpcErrorSchema,
  HostFatalErrorSchema,
]);
export type HostOutbound = z.infer<typeof HostOutboundSchema>;

/** Validate without returning Zod's stripped clone. v2 allows compatible extra keys. */
export function decodeInbound(line: string): HostInbound | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = HostInboundSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.op === "rpc") {
    const spec = HOST_RPC_SCHEMAS[parsed.data.method];
    if (!spec.params.safeParse(parsed.data.params ?? {}).success) return null;
  }
  return value as HostInbound;
}

/** Validate without returning Zod's stripped clone. v2 allows compatible extra keys. */
export function decodeOutbound(line: string): HostOutbound | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return HostOutboundSchema.safeParse(value).success ? (value as HostOutbound) : null;
}

export function validateRpcResult<M extends RpcMethod>(
  method: M,
  value: unknown,
): value is HostRpcMethodResult<M> {
  return HOST_RPC_SCHEMAS[method].result.safeParse(value).success;
}
