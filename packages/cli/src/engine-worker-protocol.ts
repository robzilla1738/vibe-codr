import type {
  AgentInfo,
  EngineCommand,
  EngineSnapshot,
  ModelSummary,
  ProviderInfo,
  SkillInfo,
  UIEvent,
  RunEventV1,
} from "@vibe/protocol";

export interface EngineWorkerRpcResults {
  snapshot: EngineSnapshot;
  listModels: ModelSummary[];
  listProviders: ProviderInfo[];
  listAgents: AgentInfo[];
  listSkills: SkillInfo[];
  finalize: undefined;
}

export type EngineWorkerRpcOp = keyof EngineWorkerRpcResults;

export interface EngineWorkerData {
  config: unknown;
  cwd: string;
  interactive: boolean;
  projectMemory?: string;
  resume?: unknown;
  modelOverride?: string;
  modeOverride?: string;
  env?: Record<string, string | undefined>;
}

export interface EngineWorkerRpcRequest<Op extends EngineWorkerRpcOp = EngineWorkerRpcOp> {
  __req: number;
  op: Op;
}

export type EngineWorkerRpcSuccess<Op extends EngineWorkerRpcOp = EngineWorkerRpcOp> = {
  __resp: number;
  ok: true;
  value: EngineWorkerRpcResults[Op];
};

export interface EngineWorkerRpcError {
  __resp: number;
  ok: false;
  error: string;
}

export interface EngineWorkerFatal {
  __fatal__: true;
  message: string;
  /** Optional only for one-release compatibility with an older worker binary. */
  runEventTail?: RunEventV1[];
}

/** Host → worker. Commands remain unwrapped for zero-copy structured cloning. */
export type EngineWorkerInbound = EngineCommand | EngineWorkerRpcRequest;

/** Worker → host. UI events remain unwrapped for zero-copy structured cloning. */
export type EngineWorkerOutbound =
  | UIEvent
  | EngineWorkerRpcSuccess
  | EngineWorkerRpcError
  | EngineWorkerFatal;

const hasKey = (value: unknown, key: string): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && key in value;

export const isEngineWorkerRpcRequest = (value: unknown): value is EngineWorkerRpcRequest =>
  hasKey(value, "__req");

export const isEngineWorkerRpcResponse = (
  value: EngineWorkerOutbound,
): value is EngineWorkerRpcSuccess | EngineWorkerRpcError => hasKey(value, "__resp");

export const isEngineWorkerFatal = (value: EngineWorkerOutbound): value is EngineWorkerFatal =>
  hasKey(value, "__fatal__");

export const isEngineWorkerEvent = (value: EngineWorkerOutbound): value is UIEvent =>
  !isEngineWorkerRpcResponse(value) && !isEngineWorkerFatal(value) && hasKey(value, "type");
