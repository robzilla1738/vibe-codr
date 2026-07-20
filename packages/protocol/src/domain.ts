import { z } from "zod";

const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape);
const finite = z.number().finite();
const nonNegative = finite.min(0);
const positive = finite.gt(0);
const safeInteger = z.number().refine(Number.isSafeInteger, "expected a safe integer");
const nonNegativeSafeInteger = safeInteger.refine(
  (value) => value >= 0,
  "expected a non-negative integer",
);
export const PROTOCOL_LIMITS_V1 = Object.freeze({
  runtimeIdentifierChars: 1_024,
  catalogItems: 20_000,
  catalogFieldChars: 16 * 1_024,
  catalogErrorChars: 64 * 1_024,
  providerEnvItems: 64,
  providerEnvChars: 1_024,
  searchHits: 100,
  searchSnippetChars: 260,
  replayEvents: 2_048,
  pathChars: 32_768,
  queryChars: 512,
  titleChars: 1_024,
  engineRevisionChars: 256,
} as const);

export const RuntimeIdentifierSchema = z
  .string()
  .min(1)
  .max(PROTOCOL_LIMITS_V1.runtimeIdentifierChars)
  .refine((value) => !value.includes("\0"));
export const CatalogIdentifierSchema = z
  .string()
  .min(1)
  .max(PROTOCOL_LIMITS_V1.catalogFieldChars)
  .refine((value) => !value.includes("\0"));
export const CatalogDisplayStringSchema = z
  .string()
  .max(PROTOCOL_LIMITS_V1.catalogFieldChars)
  .refine((value) => !value.includes("\0"));
const runtimeIdentifier = RuntimeIdentifierSchema;

export const ModeSchema = z.enum(["plan", "execute"]);
export type Mode = z.infer<typeof ModeSchema>;

export const RoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type Role = z.infer<typeof RoleSchema>;

const TextPartSchema = loose({ type: z.literal("text"), text: z.string() });
const ReasoningPartSchema = loose({ type: z.literal("reasoning"), text: z.string() });
const ToolCallPartSchema = loose({
  type: z.literal("tool-call"),
  toolCallId: runtimeIdentifier,
  toolName: z.string(),
  input: z.unknown(),
});
const ToolResultPartSchema = loose({
  type: z.literal("tool-result"),
  toolCallId: runtimeIdentifier,
  toolName: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
});
export const PartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ReasoningPartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
]);
export type Part = z.infer<typeof PartSchema>;

export const TaskStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export const TaskSchema = loose({
  id: runtimeIdentifier,
  title: z.string(),
  status: TaskStatusSchema,
});
export type Task = z.infer<typeof TaskSchema>;

export const ModelSummarySchema = loose({
  id: CatalogIdentifierSchema,
  providerId: CatalogIdentifierSchema,
  name: CatalogDisplayStringSchema.optional(),
  contextWindow: positive.optional(),
});
export type ModelSummary = z.infer<typeof ModelSummarySchema>;

export const ProviderInfoSchema = loose({
  id: CatalogIdentifierSchema,
  configured: z.boolean(),
  keyless: z.boolean(),
  env: z
    .array(
      z
        .string()
        .min(1)
        .max(PROTOCOL_LIMITS_V1.providerEnvChars)
        .refine((value) => !value.includes("\0")),
    )
    .max(PROTOCOL_LIMITS_V1.providerEnvItems),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export const AgentCapabilitySchema = z.enum([
  "research",
  "code",
  "test",
  "review",
  "network",
  "shell",
]);
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;
export const AgentInfoSchema = loose({
  name: CatalogIdentifierSchema,
  description: CatalogDisplayStringSchema,
  model: CatalogIdentifierSchema.nullable(),
  mode: ModeSchema,
  persona: z.string().optional(),
  capabilities: z.array(AgentCapabilitySchema).optional(),
  inputArtifact: z.string().optional(),
  outputArtifact: z.string().optional(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const GoalContractSchema = loose({
  goal: z.string(),
  acceptanceCriteria: z.array(z.string()),
  verificationPlan: z.array(z.string()),
  nonGoals: z.array(z.string()),
  assumedScope: z.array(z.string()),
  implementationPlan: z.array(z.string()),
  risks: z.array(z.string()),
  frozenAt: finite,
});
export type GoalContract = z.infer<typeof GoalContractSchema>;

export const GoalCompletionStatusSchema = z.enum([
  "verified",
  "met-unverified",
  "paused",
  "unmet",
]);
export type GoalCompletionStatus = z.infer<typeof GoalCompletionStatusSchema>;

/** Temporary v0.7 compatibility field. It never upgrades unverified work. */
export function legacyGoalMet(status: GoalCompletionStatus): boolean {
  return status === "verified" || status === "met-unverified";
}

function completionFieldsAgree(value: {
  goalCompletionStatus?: GoalCompletionStatus;
  met?: boolean;
}): boolean {
  return value.goalCompletionStatus === undefined
    || value.met === undefined
    || value.met === legacyGoalMet(value.goalCompletionStatus);
}

const SourceSchema = loose({ url: z.string(), title: z.string().optional() });
export const PlanStateSchema = loose({
  status: z.enum(["inactive", "active", "pending", "exit_pending"]),
  plan: z.string().optional(),
  sources: z.array(SourceSchema).optional(),
  assumptions: z.array(z.string()).optional(),
  ungrounded: z.boolean().optional(),
  updatedAt: nonNegative,
});
export type PlanState = z.infer<typeof PlanStateSchema>;

export const QuestionChoiceSchema = loose({
  label: z.string(),
  description: z.string().optional(),
});
export type QuestionChoice = z.infer<typeof QuestionChoiceSchema>;
export const StructuredQuestionSchema = loose({
  id: runtimeIdentifier,
  question: z.string(),
  header: z.string().optional(),
  choices: z.array(QuestionChoiceSchema),
  multiple: z.boolean(),
  allowFreeform: z.boolean(),
  createdAt: nonNegative,
});
export type StructuredQuestion = z.infer<typeof StructuredQuestionSchema>;

export const ActivityMetricsSchema = loose({
  turns: nonNegative.optional(),
  toolCalls: nonNegative.optional(),
  inputTokens: nonNegative.optional(),
  outputTokens: nonNegative.optional(),
  contextTokens: nonNegative.optional(),
  contextWindow: nonNegative.optional(),
  errors: nonNegative.optional(),
});
export const ActivityInfoSchema = loose({
  id: runtimeIdentifier,
  kind: z.enum(["shell", "subagent", "tasks", "monitor"]),
  label: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  startedAt: nonNegative.optional(),
  finishedAt: nonNegative.optional(),
  summary: z.string().optional(),
  outputTail: z.string().optional(),
  metrics: ActivityMetricsSchema.optional(),
});
export type ActivityInfo = z.infer<typeof ActivityInfoSchema>;

export const SkillInfoSchema = loose({
  name: CatalogIdentifierSchema,
  description: CatalogDisplayStringSchema,
});
export type SkillInfo = z.infer<typeof SkillInfoSchema>;
export const QueuedItemSchema = loose({ id: runtimeIdentifier, label: z.string() });
export type QueuedItem = z.infer<typeof QueuedItemSchema>;

export const UsageSchema = loose({
  inputTokens: nonNegative.optional(),
  outputTokens: nonNegative.optional(),
  totalTokens: nonNegative.optional(),
  cachedInputTokens: nonNegative.optional(),
});
export type Usage = z.infer<typeof UsageSchema>;
export const ModelUsageSchema = loose({
  inputTokens: nonNegative,
  outputTokens: nonNegative,
  totalTokens: nonNegative,
  cachedInputTokens: nonNegative,
  cacheWriteTokens: nonNegative,
  steps: nonNegativeSafeInteger,
  turns: nonNegativeSafeInteger,
  providerLatencyMs: nonNegative,
  costUSD: nonNegative,
  actualCostUSD: nonNegative.optional(),
  costEstimated: z.boolean().optional(),
  legacyAttribution: z.boolean().optional(),
}).superRefine((usage, ctx) => {
  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    ctx.addIssue({
      code: "custom",
      path: ["totalTokens"],
      message: "totalTokens must equal inputTokens plus outputTokens",
    });
  }
  if (usage.actualCostUSD !== undefined && usage.actualCostUSD > usage.costUSD) {
    ctx.addIssue({
      code: "custom",
      path: ["actualCostUSD"],
      message: "actualCostUSD cannot exceed costUSD",
    });
  }
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;
export const SessionUsageSchema = loose({
  inputTokens: nonNegative,
  outputTokens: nonNegative,
  totalTokens: nonNegative,
  costUSD: nonNegative,
  actualCostUSD: nonNegative.optional(),
  costEstimated: z.boolean().optional(),
  cachedInputTokens: nonNegative.optional(),
  cacheWriteTokens: nonNegative.optional(),
  steps: nonNegativeSafeInteger.optional(),
  turns: nonNegativeSafeInteger.optional(),
  providerLatencyMs: nonNegative.optional(),
  /** Optional for one release so older hosts/clients remain wire-compatible. */
  byModel: z.record(CatalogIdentifierSchema, ModelUsageSchema).optional(),
}).superRefine((usage, ctx) => {
  if (!usage.byModel) return;
  const buckets = Object.values(usage.byModel);
  const sum = (field: keyof ModelUsage): number =>
    buckets.reduce((total, bucket) => total + (typeof bucket[field] === "number" ? bucket[field] : 0), 0);
  const approximatelyEqual = (left: number, right: number): boolean =>
    Math.abs(left - right) <= Math.max(1e-12, Math.abs(left) * 1e-12, Math.abs(right) * 1e-12);
  const exactFields = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "steps",
    "turns",
  ] as const;
  for (const field of exactFields) {
    if ((usage[field] ?? 0) !== sum(field)) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${field} must equal the sum of byModel buckets`,
      });
    }
  }
  if (!approximatelyEqual(usage.providerLatencyMs ?? 0, sum("providerLatencyMs"))) {
    ctx.addIssue({
      code: "custom",
      path: ["providerLatencyMs"],
      message: "providerLatencyMs must equal the sum of byModel buckets",
    });
  }
  if (!approximatelyEqual(usage.costUSD, sum("costUSD"))) {
    ctx.addIssue({
      code: "custom",
      path: ["costUSD"],
      message: "costUSD must equal the sum of byModel buckets",
    });
  }
  const bucketActualCost = buckets.reduce(
    (total, bucket) => total + (bucket.actualCostUSD ?? (bucket.costEstimated ? 0 : bucket.costUSD)),
    0,
  );
  if (usage.actualCostUSD !== undefined && !approximatelyEqual(usage.actualCostUSD, bucketActualCost)) {
    ctx.addIssue({
      code: "custom",
      path: ["actualCostUSD"],
      message: "actualCostUSD must equal the sum of byModel buckets",
    });
  }
  const hasEstimatedCost = buckets.some((bucket) =>
    bucket.costEstimated === true
      || (bucket.actualCostUSD !== undefined && bucket.actualCostUSD < bucket.costUSD)
  );
  if (Boolean(usage.costEstimated) !== hasEstimatedCost) {
    ctx.addIssue({
      code: "custom",
      path: ["costEstimated"],
      message: "costEstimated must match the byModel buckets",
    });
  }
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

export const MessageSchema = loose({
  id: runtimeIdentifier,
  role: RoleSchema,
  parts: z.array(PartSchema),
  createdAt: finite,
  usage: UsageSchema.optional(),
  subagentId: runtimeIdentifier.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const GitInfoSchema = loose({
  branch: z.string(),
  dirty: nonNegative,
  ahead: nonNegative,
  behind: nonNegative,
  worktree: z.boolean(),
});
export type GitInfo = z.infer<typeof GitInfoSchema>;

export const JobInfoSchema = loose({
  id: z.string(),
  command: z.string(),
  status: z.enum(["running", "exited", "killed"]),
  exitCode: finite.nullable(),
  pid: positive.optional(),
  servers: z.array(z.string()),
  outputTail: z.string(),
});
export type JobInfo = z.infer<typeof JobInfoSchema>;

export const GoalRunInfoSchema = loose({
  active: z.boolean(),
  phase: z.enum(["plan", "execute"]).nullable(),
  round: nonNegative,
  max: nonNegative,
  pausedReason: z.string().nullable(),
  goalCompletionStatus: GoalCompletionStatusSchema.optional(),
  /** @deprecated Derived from goalCompletionStatus for one release. */
  met: z.boolean(),
  contract: GoalContractSchema.optional(),
  stagnationCount: nonNegative.optional(),
  strategyResets: nonNegative.optional(),
}).superRefine((value, ctx) => {
  if (!completionFieldsAgree(value)) {
    ctx.addIssue({ code: "custom", path: ["met"], message: "met contradicts goalCompletionStatus" });
  }
});
export type GoalRunInfo = z.infer<typeof GoalRunInfoSchema>;

export const ExecutionTargetSchema = z.discriminatedUnion("kind", [
  loose({ kind: z.literal("local") }),
  loose({ kind: z.literal("cloud"), provider: z.enum(["e2b", "vercel"]) }),
]);
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;

export const CloudSessionStatusSchema = z.enum([
  "preparing",
  "transferring",
  "starting",
  "running",
  "needs-local",
  "suspended",
  "syncing-back",
  "recoverable-error",
]);
export type CloudSessionStatus = z.infer<typeof CloudSessionStatusSchema>;

export const PendingCapabilityRequestSchema = loose({
  id: runtimeIdentifier,
  integration: CatalogIdentifierSchema,
  toolName: CatalogIdentifierSchema,
  arguments: z.unknown(),
  approvalScope: z.enum(["once", "session", "integration"]),
  originatingTurn: runtimeIdentifier,
  status: z.enum(["pending", "approved", "denied", "resolved"]),
  createdAt: nonNegative,
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type PendingCapabilityRequest = z.infer<typeof PendingCapabilityRequestSchema>;

export const ExternalCapabilityResolutionSchema = loose({
  id: z.string(),
  status: z.enum(["denied", "resolved"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type ExternalCapabilityResolution = z.infer<typeof ExternalCapabilityResolutionSchema>;

export const PortableSessionFileV1Schema = loose({
  path: z.string(),
  bytes: nonNegativeSafeInteger,
  sha256: z.string(),
  contentBase64: z.string(),
});
export type PortableSessionFileV1 = z.infer<typeof PortableSessionFileV1Schema>;
export const PortableSessionArchiveV1Schema = loose({
  schemaVersion: z.literal(1),
  sessionId: runtimeIdentifier,
  sourceRoot: z.string(),
  sourceStateRoot: z.string(),
  ownershipGeneration: nonNegativeSafeInteger,
  executionTarget: ExecutionTargetSchema,
  engineRevision: z.string(),
  createdAt: finite,
  files: z.array(PortableSessionFileV1Schema),
  pendingCapabilities: z.array(PendingCapabilityRequestSchema),
  archiveSha256: z.string(),
});
export type PortableSessionArchiveV1 = z.infer<typeof PortableSessionArchiveV1Schema>;
export const HandoffPreparationSchema = loose({
  sessionId: runtimeIdentifier,
  ownershipGeneration: nonNegativeSafeInteger,
  previousGeneration: nonNegativeSafeInteger,
  nonce: runtimeIdentifier,
  target: ExecutionTargetSchema,
  preparedAt: finite,
});
export type HandoffPreparation = z.infer<typeof HandoffPreparationSchema>;

export const EngineSnapshotSchema = loose({
  hostInstanceId: runtimeIdentifier.optional(),
  lastEventSeq: nonNegativeSafeInteger.optional(),
  sessionId: runtimeIdentifier,
  model: z.string(),
  mode: ModeSchema,
  goal: z.string().nullable(),
  goalRun: GoalRunInfoSchema.optional(),
  planState: PlanStateSchema.optional(),
  pendingQuestion: StructuredQuestionSchema.optional(),
  activities: z.array(ActivityInfoSchema).optional(),
  history: z.array(MessageSchema),
  tasks: z.array(TaskSchema),
  usage: SessionUsageSchema,
  busy: z.boolean(),
  theme: z.string(),
  accentColor: z.string(),
  details: z.enum(["quiet", "normal", "verbose"]),
  mouse: z.boolean(),
  approvalMode: z.enum(["ask", "auto"]),
  commandNames: z.array(z.string()),
  subagentModel: z.string().optional(),
  reasoning: z.string().optional(),
  git: GitInfoSchema.optional(),
  pendingCapabilities: z.array(PendingCapabilityRequestSchema).optional(),
});
export type EngineSnapshot = z.infer<typeof EngineSnapshotSchema>;

const SubmitPromptCommandSchema = loose({ type: z.literal("submit-prompt"), text: z.string() });
const RunSlashCommandSchema = loose({
  type: z.literal("run-slash"),
  name: z.string(),
  args: z.string(),
});
const SetModeCommandSchema = loose({
  type: z.literal("set-mode"),
  mode: ModeSchema,
  start: z.boolean().optional(),
});
const SetApprovalsCommandSchema = loose({
  type: z.literal("set-approvals"),
  mode: z.enum(["ask", "auto"]),
  quiet: z.boolean().optional(),
});
const SetModelCommandSchema = loose({ type: z.literal("set-model"), model: z.string() });
const SetSubagentModelCommandSchema = loose({
  type: z.literal("set-subagent-model"),
  model: z.string().nullable(),
});
const SetAgentModelCommandSchema = loose({
  type: z.literal("set-agent-model"),
  name: z.string(),
  model: z.string().nullable(),
});
const CreateAgentCommandSchema = loose({ type: z.literal("create-agent"), name: z.string() });
const SetGoalCommandSchema = loose({ type: z.literal("set-goal"), goal: z.string().nullable() });
const ResumeGoalCommandSchema = loose({ type: z.literal("resume-goal") });
const AbortCommandSchema = loose({ type: z.literal("abort") });
const DequeueCommandSchema = loose({ type: z.literal("dequeue"), id: runtimeIdentifier });
const SteerCommandSchema = loose({ type: z.literal("steer"), id: runtimeIdentifier });
const CompactCommandSchema = loose({ type: z.literal("compact") });
const RequestRuntimeHandoffCommandSchema = loose({
  type: z.literal("request-runtime-handoff"),
  target: ExecutionTargetSchema,
  instruction: z.string().optional(),
});
const ResolveExternalCapabilityCommandSchema = loose({
  type: z.literal("resolve-external-capability"),
  id: runtimeIdentifier,
  decision: z.enum(["approve", "deny"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
const ResolvePermissionCommandSchema = loose({
  type: z.literal("resolve-permission"),
  id: runtimeIdentifier,
  decision: z.enum(["once", "always", "always-project", "deny"]),
  feedback: z.string().optional(),
});
const ResolvePlanCommandSchema = loose({
  type: z.literal("resolve-plan"),
  decision: z.enum(["accept", "edit", "keep-planning"]),
  edit: z.string().optional(),
  approvals: z.literal("auto").optional(),
});
const ResolveQuestionCommandSchema = loose({
  type: z.literal("resolve-question"),
  id: runtimeIdentifier,
  answers: z.array(z.string()),
  freeform: z.string().optional(),
});
const CancelActivityCommandSchema = loose({
  type: z.literal("cancel-activity"),
  id: runtimeIdentifier,
});
const ShutdownCommandSchema = loose({ type: z.literal("shutdown") });

export const EngineCommandSchema = z.discriminatedUnion("type", [
  SubmitPromptCommandSchema,
  RunSlashCommandSchema,
  SetModeCommandSchema,
  SetApprovalsCommandSchema,
  SetModelCommandSchema,
  SetSubagentModelCommandSchema,
  SetAgentModelCommandSchema,
  CreateAgentCommandSchema,
  SetGoalCommandSchema,
  ResumeGoalCommandSchema,
  AbortCommandSchema,
  DequeueCommandSchema,
  SteerCommandSchema,
  CompactCommandSchema,
  RequestRuntimeHandoffCommandSchema,
  ResolveExternalCapabilityCommandSchema,
  ResolvePermissionCommandSchema,
  ResolvePlanCommandSchema,
  ResolveQuestionCommandSchema,
  CancelActivityCommandSchema,
  ShutdownCommandSchema,
]);
export type EngineCommand = z.infer<typeof EngineCommandSchema>;
export type EngineCommandType = EngineCommand["type"];
export const ENGINE_COMMAND_SCHEMAS = {
  "submit-prompt": SubmitPromptCommandSchema,
  "run-slash": RunSlashCommandSchema,
  "set-mode": SetModeCommandSchema,
  "set-approvals": SetApprovalsCommandSchema,
  "set-model": SetModelCommandSchema,
  "set-subagent-model": SetSubagentModelCommandSchema,
  "set-agent-model": SetAgentModelCommandSchema,
  "create-agent": CreateAgentCommandSchema,
  "set-goal": SetGoalCommandSchema,
  "resume-goal": ResumeGoalCommandSchema,
  abort: AbortCommandSchema,
  dequeue: DequeueCommandSchema,
  steer: SteerCommandSchema,
  compact: CompactCommandSchema,
  "request-runtime-handoff": RequestRuntimeHandoffCommandSchema,
  "resolve-external-capability": ResolveExternalCapabilityCommandSchema,
  "resolve-permission": ResolvePermissionCommandSchema,
  "resolve-plan": ResolvePlanCommandSchema,
  "resolve-question": ResolveQuestionCommandSchema,
  "cancel-activity": CancelActivityCommandSchema,
  shutdown: ShutdownCommandSchema,
} as const satisfies Record<EngineCommandType, z.ZodType>;
export const ENGINE_COMMAND_TYPES = Object.freeze(
  Object.keys(ENGINE_COMMAND_SCHEMAS) as EngineCommandType[],
);

export const TurnPerformanceSampleSchema = loose({
  turnId: runtimeIdentifier,
  sessionId: runtimeIdentifier,
  model: z.string(),
  serviceTier: z.enum(["default", "priority"]),
  startedAt: nonNegative,
  queueDelayMs: nonNegative,
  hooksMs: nonNegative,
  checkpointMs: nonNegative,
  recallMs: nonNegative,
  attachmentsMs: nonNegative,
  modelResolveMs: nonNegative,
  contextPrepareMs: nonNegative,
  providerTtftMs: nonNegative.optional(),
  firstReasoningMs: nonNegative.optional(),
  firstVisibleTextMs: nonNegative.optional(),
  generationMs: nonNegative,
  toolMs: nonNegative,
  toolSchemaTokens: nonNegative.optional(),
  persistMs: nonNegative,
  postTurnMs: nonNegative,
  totalMs: nonNegative,
  inputTokens: nonNegative.optional(),
  cachedInputTokens: nonNegative.optional(),
  cacheWriteTokens: nonNegative.optional(),
  outputTokens: nonNegative.optional(),
  steps: nonNegativeSafeInteger.optional(),
  providerLatencyMs: nonNegative.optional(),
  costUSD: nonNegative.optional(),
  actualCostUSD: nonNegative.optional(),
  costEstimated: z.boolean().optional(),
  outcome: z.enum(["completed", "failed", "cancelled"]).optional(),
});
export type TurnPerformanceSample = z.infer<typeof TurnPerformanceSampleSchema>;

const session = { sessionId: runtimeIdentifier } as const;
const eventSchemas = {
  "session-start": loose({
    type: z.literal("session-start"),
    ...session,
    model: z.string(),
    mode: ModeSchema,
  }),
  "user-message": loose({
    type: z.literal("user-message"),
    ...session,
    text: z.string(),
    origin: z.enum(["user", "engine"]).optional(),
    label: z.string().optional(),
    turnId: runtimeIdentifier.optional(),
  }),
  "assistant-text-delta": loose({
    type: z.literal("assistant-text-delta"),
    ...session,
    subagentId: runtimeIdentifier.optional(),
    delta: z.string(),
  }),
  "reasoning-delta": loose({
    type: z.literal("reasoning-delta"),
    ...session,
    subagentId: runtimeIdentifier.optional(),
    delta: z.string(),
  }),
  "tool-call-started": loose({
    type: z.literal("tool-call-started"),
    ...session,
    subagentId: runtimeIdentifier.optional(),
    toolCallId: runtimeIdentifier,
    toolName: z.string(),
    input: z.unknown(),
  }),
  "tool-call-progress": loose({
    type: z.literal("tool-call-progress"),
    ...session,
    subagentId: runtimeIdentifier.optional(),
    toolCallId: runtimeIdentifier,
    chunk: z.string(),
  }),
  "tool-call-finished": loose({
    type: z.literal("tool-call-finished"),
    ...session,
    subagentId: runtimeIdentifier.optional(),
    toolCallId: runtimeIdentifier,
    toolName: z.string(),
    output: z.unknown(),
    isError: z.boolean(),
  }),
  "step-finished": loose({
    type: z.literal("step-finished"),
    ...session,
    usage: UsageSchema.optional(),
  }),
  "usage-updated": loose({
    type: z.literal("usage-updated"),
    ...session,
    usage: SessionUsageSchema,
  }),
  "context-updated": loose({
    type: z.literal("context-updated"),
    ...session,
    usedTokens: nonNegative,
    contextWindow: positive,
  }),
  "mode-changed": loose({ type: z.literal("mode-changed"), ...session, mode: ModeSchema }),
  "model-changed": loose({ type: z.literal("model-changed"), ...session, model: z.string() }),
  "goal-changed": loose({
    type: z.literal("goal-changed"),
    ...session,
    goal: z.string().nullable(),
  }),
  "goal-run": loose({ type: z.literal("goal-run"), ...session, run: GoalRunInfoSchema }),
  "plan-state-changed": loose({
    type: z.literal("plan-state-changed"),
    ...session,
    state: PlanStateSchema,
  }),
  "question-request": loose({
    type: z.literal("question-request"),
    ...session,
    question: StructuredQuestionSchema,
  }),
  "question-settled": loose({
    type: z.literal("question-settled"),
    ...session,
    id: runtimeIdentifier,
    reason: z.enum(["answered", "aborted", "shutdown", "timeout"]),
  }),
  "activities-changed": loose({
    type: z.literal("activities-changed"),
    ...session,
    activities: z.array(ActivityInfoSchema),
  }),
  "theme-changed": loose({ type: z.literal("theme-changed"), theme: z.string() }),
  "accent-changed": loose({ type: z.literal("accent-changed"), accent: z.string() }),
  "details-changed": loose({
    type: z.literal("details-changed"),
    details: z.enum(["quiet", "normal", "verbose"]),
  }),
  "mouse-changed": loose({ type: z.literal("mouse-changed"), mouse: z.boolean() }),
  "git-updated": loose({ type: z.literal("git-updated"), ...session, git: GitInfoSchema }),
  "jobs-changed": loose({
    type: z.literal("jobs-changed"),
    ...session,
    jobs: z.array(JobInfoSchema),
  }),
  "approvals-changed": loose({
    type: z.literal("approvals-changed"),
    mode: z.enum(["ask", "auto"]),
  }),
  "plan-presented": loose({
    type: z.literal("plan-presented"),
    ...session,
    plan: z.string(),
    sources: z.array(SourceSchema).optional(),
    assumptions: z.array(z.string()).optional(),
    ungrounded: z.boolean().optional(),
  }),
  "permission-request": loose({
    type: z.literal("permission-request"),
    ...session,
    id: runtimeIdentifier,
    toolName: z.string(),
    input: z.unknown(),
  }),
  "permission-settled": loose({
    type: z.literal("permission-settled"),
    ...session,
    ids: z.array(runtimeIdentifier),
    reason: z.enum(["aborted", "shutdown"]),
  }),
  "tasks-updated": loose({
    type: z.literal("tasks-updated"),
    ...session,
    tasks: z.array(TaskSchema),
  }),
  "orchestration-task": loose({
    type: z.literal("orchestration-task"),
    ...session,
    taskId: runtimeIdentifier,
    objective: z.string(),
    status: z.enum(["running", "completed", "failed", "skipped"]),
    attempts: nonNegative.optional(),
    durationMs: nonNegative.optional(),
  }),
  "queue-changed": loose({
    type: z.literal("queue-changed"),
    active: QueuedItemSchema.nullable(),
    pending: z.array(QueuedItemSchema),
  }),
  "file-changed": loose({
    type: z.literal("file-changed"),
    ...session,
    toolCallId: runtimeIdentifier,
    path: z.string(),
    action: z.enum(["edit", "write"]),
    diff: z.string(),
    added: nonNegative,
    removed: nonNegative,
  }),
  "checkpoint-created": loose({
    type: z.literal("checkpoint-created"),
    id: runtimeIdentifier,
    label: z.string(),
  }),
  "checkpoint-restored": loose({
    type: z.literal("checkpoint-restored"),
    id: runtimeIdentifier,
    label: z.string(),
  }),
  "verify-started": loose({ type: z.literal("verify-started"), command: z.string() }),
  "verify-finished": loose({
    type: z.literal("verify-finished"),
    ok: z.boolean(),
    output: z.string(),
  }),
  compacted: loose({ type: z.literal("compacted"), ...session, freedTokens: nonNegative }),
  "runtime-handoff-requested": loose({
    type: z.literal("runtime-handoff-requested"),
    ...session,
    target: ExecutionTargetSchema,
    instruction: z.string().optional(),
  }),
  "external-capability-pending": loose({
    type: z.literal("external-capability-pending"),
    ...session,
    request: PendingCapabilityRequestSchema,
  }),
  "external-capability-resolved": loose({
    type: z.literal("external-capability-resolved"),
    ...session,
    id: runtimeIdentifier,
    status: z.enum(["denied", "resolved"]),
  }),
  "subagent-started": loose({
    type: z.literal("subagent-started"),
    ...session,
    subagentId: runtimeIdentifier,
    prompt: z.string(),
    agent: z.string().optional(),
    startedAt: nonNegative.optional(),
  }),
  "subagent-activity": loose({
    type: z.literal("subagent-activity"),
    ...session,
    subagentId: runtimeIdentifier,
    label: z.string(),
    transcriptDelta: z.string().optional(),
    metrics: ActivityMetricsSchema.optional(),
  }),
  "subagent-finished": loose({
    type: z.literal("subagent-finished"),
    ...session,
    subagentId: runtimeIdentifier,
    result: z.string(),
    finishedAt: nonNegative.optional(),
    transcript: z.string().optional(),
    metrics: ActivityMetricsSchema.optional(),
  }),
  "loop-tick": loose({
    type: z.literal("loop-tick"),
    loopId: runtimeIdentifier,
    iteration: nonNegative,
  }),
  "loop-stopped": loose({
    type: z.literal("loop-stopped"),
    loopId: runtimeIdentifier,
    reason: z.string(),
  }),
  notice: loose({
    type: z.literal("notice"),
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
  }),
  "engine-error": loose({
    type: z.literal("engine-error"),
    sessionId: runtimeIdentifier.optional(),
    message: z.string(),
  }),
  "turn-finished": loose({ type: z.literal("turn-finished"), ...session }),
  "turn-performance": loose({
    type: z.literal("turn-performance"),
    ...session,
    sample: TurnPerformanceSampleSchema,
  }),
  "session-idle": loose({ type: z.literal("session-idle"), ...session }),
  "engine-idle": loose({
    type: z.literal("engine-idle"),
    ...session,
    gate: z.enum(["green", "red", "unverified", "aborted"]).optional(),
    goalCompletionStatus: GoalCompletionStatusSchema.optional(),
    /** @deprecated Derived from goalCompletionStatus for one release. */
    met: z.boolean().optional(),
  }).superRefine((value, ctx) => {
    if (!completionFieldsAgree(value)) {
      ctx.addIssue({ code: "custom", path: ["met"], message: "met contradicts goalCompletionStatus" });
    }
  }),
} as const;

export const UIEventSchema = z.discriminatedUnion(
  "type",
  Object.values(eventSchemas) as [
    (typeof eventSchemas)[keyof typeof eventSchemas],
    ...(typeof eventSchemas)[keyof typeof eventSchemas][],
  ],
);
export type UIEvent = z.infer<typeof UIEventSchema>;
export type UIEventType = UIEvent["type"];
export const UI_EVENT_SCHEMAS = eventSchemas satisfies Record<UIEventType, z.ZodType>;
export const UI_EVENT_TYPES = Object.freeze(Object.keys(UI_EVENT_SCHEMAS) as UIEventType[]);

export function isEngineCommand(value: unknown): value is EngineCommand {
  return EngineCommandSchema.safeParse(value).success;
}

export function isUIEvent(value: unknown): value is UIEvent {
  return UIEventSchema.safeParse(value).success;
}
