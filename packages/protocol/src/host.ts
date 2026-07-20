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
const schemaUnion = <S extends z.ZodType>(schemas: readonly S[]) => {
  const first = schemas[0];
  const second = schemas[1];
  if (!first || !second) throw new Error("schema union requires at least two variants");
  return z.union([first, second, ...schemas.slice(2)]);
};

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
const rpcParamFields = {
  cwd: z.string(),
  id: z.string(),
  name: z.string(),
  title: z.string(),
  sessionId: z.string(),
  target: ExecutionTargetSchema,
  expectedGeneration: nonNegativeSafeInteger,
  ownershipGeneration: nonNegativeSafeInteger,
  nonce: z.string(),
  engineRevision: z.string(),
  archive: PortableSessionArchiveV1Schema,
  archivePath: z.string(),
  provisional: z.boolean(),
  providerId: providerIdSchema,
  authMethod: authMethodSchema,
  authSessionId: z.string(),
  hostInstanceId: z.string(),
  afterSeq: nonNegativeSafeInteger,
  query: z.string(),
  limit: nonNegativeSafeInteger,
  atTurnId: z.string(),
} as const;
export const HostRpcParamsSchema = z.object(rpcParamFields).partial().strict();
export type HostRpcParams = z.infer<typeof HostRpcParamsSchema>;

const noParams = z.object({}).strict();
type RpcParamKey = keyof typeof rpcParamFields;
type RpcParamShape<R extends RpcParamKey, O extends RpcParamKey> = {
  [K in R]: (typeof rpcParamFields)[K];
} & {
  [K in O]: z.ZodOptional<(typeof rpcParamFields)[K]>;
};
const params = <
  const Required extends readonly RpcParamKey[],
  const Optional extends readonly Exclude<RpcParamKey, Required[number]>[],
>(
  required: Required,
  optional: Optional,
) => {
  const shape = {} as RpcParamShape<Required[number], Optional[number]>;
  const mutable = shape as Partial<Record<RpcParamKey, z.ZodType>>;
  for (const key of required) mutable[key] = rpcParamFields[key];
  for (const key of optional) mutable[key] = rpcParamFields[key].optional();
  return z.object(shape).strict();
};

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
const rpc = <P extends z.ZodType, R extends z.ZodType>(paramsSchema: P, result: R) =>
  ({ params: paramsSchema, result, paramsRequired: true }) as const;
const optionalParamsRpc = <P extends z.ZodType, R extends z.ZodType>(paramsSchema: P, result: R) =>
  ({ params: paramsSchema, result, paramsRequired: false }) as const;
const parameterlessRpc = <R extends z.ZodType>(result: R) =>
  ({ params: noParams, result, paramsRequired: false }) as const;

const importPortableSessionParamsSchema = params(
  ["engineRevision"],
  ["cwd", "archive", "archivePath", "provisional"],
).superRefine((value, ctx) => {
  if (value.archive === undefined && value.archivePath === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "archive or archivePath is required",
    });
  }
});
const recoverLostCloudOwnershipParamsSchema = z
  .object({
    cwd: rpcParamFields.cwd.optional(),
    sessionId: rpcParamFields.sessionId,
    target: z.object({ kind: z.literal("cloud"), provider: z.enum(["e2b", "vercel"]) }),
    expectedGeneration: rpcParamFields.expectedGeneration,
  })
  .strict();
const abortInterruptedHandoffParamsSchema = z
  .object({
    cwd: rpcParamFields.cwd.optional(),
    sessionId: rpcParamFields.sessionId,
    target: rpcParamFields.target,
    expectedGeneration: positiveSafeInteger.optional(),
  })
  .strict();
const portableImportSettlementParamsSchema = z
  .object({
    cwd: rpcParamFields.cwd.optional(),
    sessionId: rpcParamFields.sessionId,
    ownershipGeneration: positiveSafeInteger,
  })
  .strict();

export const HOST_RPC_SCHEMAS = {
  snapshot: parameterlessRpc(HostSnapshotSchema),
  replayEvents: rpc(params(["afterSeq"], ["hostInstanceId"]), HostReplayResultSchema),
  listModels: parameterlessRpc(z.array(ModelSummarySchema)),
  listProviders: parameterlessRpc(z.array(ProviderInfoSchema)),
  listAgents: parameterlessRpc(z.array(AgentInfoSchema)),
  listSkills: parameterlessRpc(z.array(SkillInfoSchema)),
  listMcp: parameterlessRpc(z.array(McpServerSummarySchema)),
  listPluginStatus: parameterlessRpc(z.array(PluginStatusSchema)),
  providerAuthStatus: rpc(params(["providerId"], ["authSessionId"]), SubscriptionAuthStatusSchema),
  beginProviderAuth: rpc(params(["providerId", "authMethod"], []), SubscriptionAuthStartSchema),
  cancelProviderAuth: rpc(params(["providerId", "authSessionId"], []), nullResult),
  logoutProviderAuth: rpc(params(["providerId"], []), nullResult),
  exportProviderAuth: rpc(params(["providerId"], []), ExportedProviderCredentialSchema),
  finalize: parameterlessRpc(nullResult),
  listSessions: parameterlessRpc(z.array(SessionMetaSchema)),
  searchSessions: optionalParamsRpc(
    params([], ["cwd", "query", "limit"]),
    z.array(SessionSearchHitSchema),
  ),
  listProjects: parameterlessRpc(z.array(ProjectSummarySchema)),
  renameProject: rpc(params(["name"], ["cwd"]), loose({ cwd: z.string(), name: z.string() })),
  archiveProject: optionalParamsRpc(params([], ["cwd"]), cwdResult),
  deleteProject: optionalParamsRpc(params([], ["cwd"]), cwdResult),
  renameSession: rpc(
    params(["id", "title"], ["cwd"]),
    loose({ id: z.string(), title: z.string() }),
  ),
  deleteSession: rpc(params(["id"], ["cwd"]), idResult),
  archiveSession: rpc(params(["id"], ["cwd"]), idResult),
  forkSession: rpc(
    params(["id"], ["cwd", "atTurnId"]),
    loose({ id: z.string(), cwd: z.string(), atTurnId: z.string() }),
  ),
  prepareHandoff: rpc(params(["target"], ["expectedGeneration"]), HandoffPreparationSchema),
  exportPortableSession: rpc(
    params(["engineRevision", "ownershipGeneration"], []),
    PortableSessionArchiveV1Schema,
  ),
  importPortableSession: rpc(importPortableSessionParamsSchema, loose({ sessionId: z.string() })),
  commitPortableImport: rpc(portableImportSettlementParamsSchema, nullResult),
  abortPortableImport: rpc(portableImportSettlementParamsSchema, nullResult),
  recoverLostCloudOwnership: rpc(recoverLostCloudOwnershipParamsSchema, nonNegativeSafeInteger),
  abortInterruptedHandoff: rpc(
    abortInterruptedHandoffParamsSchema,
    loose({
      outcome: z.enum(["aborted", "already-committed"]),
      generation: nonNegativeSafeInteger,
    }),
  ),
  commitHandoff: rpc(params(["nonce"], ["cwd", "sessionId"]), nullResult),
  abortHandoff: rpc(params(["nonce"], ["cwd", "sessionId"]), nullResult),
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
  [K in M]: (typeof HOST_RPC_SCHEMAS)[K]["paramsRequired"] extends true
    ? { op: "rpc"; id: number; method: K; params: HostRpcMethodParams<K> }
    : { op: "rpc"; id: number; method: K; params?: HostRpcMethodParams<K> };
}[M];

const rpcRequestSchema = <M extends RpcMethod>(method: M) => {
  const spec = HOST_RPC_SCHEMAS[method];
  return loose({
    op: z.literal("rpc"),
    id: positiveSafeInteger,
    method: z.literal(method),
    params: spec.paramsRequired ? spec.params : spec.params.optional(),
  });
};
export const HOST_RPC_REQUEST_SCHEMAS = {
  snapshot: rpcRequestSchema("snapshot"),
  replayEvents: rpcRequestSchema("replayEvents"),
  listModels: rpcRequestSchema("listModels"),
  listProviders: rpcRequestSchema("listProviders"),
  listAgents: rpcRequestSchema("listAgents"),
  listSkills: rpcRequestSchema("listSkills"),
  listMcp: rpcRequestSchema("listMcp"),
  listPluginStatus: rpcRequestSchema("listPluginStatus"),
  providerAuthStatus: rpcRequestSchema("providerAuthStatus"),
  beginProviderAuth: rpcRequestSchema("beginProviderAuth"),
  cancelProviderAuth: rpcRequestSchema("cancelProviderAuth"),
  logoutProviderAuth: rpcRequestSchema("logoutProviderAuth"),
  exportProviderAuth: rpcRequestSchema("exportProviderAuth"),
  finalize: rpcRequestSchema("finalize"),
  listSessions: rpcRequestSchema("listSessions"),
  searchSessions: rpcRequestSchema("searchSessions"),
  listProjects: rpcRequestSchema("listProjects"),
  renameProject: rpcRequestSchema("renameProject"),
  archiveProject: rpcRequestSchema("archiveProject"),
  deleteProject: rpcRequestSchema("deleteProject"),
  renameSession: rpcRequestSchema("renameSession"),
  deleteSession: rpcRequestSchema("deleteSession"),
  archiveSession: rpcRequestSchema("archiveSession"),
  forkSession: rpcRequestSchema("forkSession"),
  prepareHandoff: rpcRequestSchema("prepareHandoff"),
  exportPortableSession: rpcRequestSchema("exportPortableSession"),
  importPortableSession: rpcRequestSchema("importPortableSession"),
  commitPortableImport: rpcRequestSchema("commitPortableImport"),
  abortPortableImport: rpcRequestSchema("abortPortableImport"),
  recoverLostCloudOwnership: rpcRequestSchema("recoverLostCloudOwnership"),
  abortInterruptedHandoff: rpcRequestSchema("abortInterruptedHandoff"),
  commitHandoff: rpcRequestSchema("commitHandoff"),
  abortHandoff: rpcRequestSchema("abortHandoff"),
} as const satisfies Record<RpcMethod, z.ZodType>;
export const HostRpcRequestSchema = schemaUnion(Object.values(HOST_RPC_REQUEST_SCHEMAS));
export const HostSendSchema = loose({
  op: z.literal("send"),
  command: EngineCommandSchema,
});
export const HostShutdownSchema = loose({ op: z.literal("shutdown") });
export const HOST_INBOUND_FRAME_SCHEMAS = {
  bootstrap: HostBootstrapSchema,
  send: HostSendSchema,
  rpc: HostRpcRequestSchema,
  shutdown: HostShutdownSchema,
} as const;
export type HostInboundOp = keyof typeof HOST_INBOUND_FRAME_SCHEMAS;
export const HOST_INBOUND_OPS = Object.freeze(
  Object.keys(HOST_INBOUND_FRAME_SCHEMAS) as HostInboundOp[],
);
export type HostInbound =
  | z.infer<typeof HostBootstrapSchema | typeof HostSendSchema | typeof HostShutdownSchema>
  | HostRpcRequest;
export const HostInboundSchema = schemaUnion(Object.values(HOST_INBOUND_FRAME_SCHEMAS));

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
export const HostRpcResponseSchema = z.union([HostRpcSuccessSchema, HostRpcErrorSchema]);
export const HOST_OUTBOUND_FRAME_SCHEMAS = {
  ready: HostReadyFrameSchema,
  event: HostEventFrameSchema,
  resp: HostRpcResponseSchema,
  fatal: HostFatalErrorSchema,
} as const;
export type HostOutboundType = keyof typeof HOST_OUTBOUND_FRAME_SCHEMAS;
export const HOST_OUTBOUND_TYPES = Object.freeze(
  Object.keys(HOST_OUTBOUND_FRAME_SCHEMAS) as HostOutboundType[],
);
export type HostOutbound = z.infer<
  (typeof HOST_OUTBOUND_FRAME_SCHEMAS)[keyof typeof HOST_OUTBOUND_FRAME_SCHEMAS]
>;
export const HostOutboundSchema = schemaUnion(Object.values(HOST_OUTBOUND_FRAME_SCHEMAS));

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
