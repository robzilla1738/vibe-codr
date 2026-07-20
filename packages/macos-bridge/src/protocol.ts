/** Compatibility facade for desktop hosts. Canonical v2 schemas live in @vibe/protocol. */
export {
  HOST_PROTOCOL_VERSION,
  HOST_PROTOCOL_CAPABILITIES,
  HOST_RPC_SCHEMAS,
  ENGINE_COMMAND_SCHEMAS,
  UI_EVENT_SCHEMAS,
  RPC_METHODS,
  decodeInbound,
  decodeOutbound,
  isUIEvent,
  validateRpcResult,
  ENGINE_COMMAND_TYPES,
  UI_EVENT_TYPES,
} from "@vibe/protocol";

export type {
  HostProtocolCapability,
  HostEventFrame,
  HostReplayResult,
  HostSnapshot,
  HostRpcParams,
  HostRpcRequest,
  HostRpcMethodParams,
  HostRpcMethodResult,
  HostInbound,
  HostOutbound,
  HostRpcError,
  HostFatalError,
  ProjectSessionSummary,
  SessionSearchHit,
  ProjectSummary,
  RpcMethod,
} from "@vibe/protocol";

import { ENGINE_COMMAND_TYPES, UI_EVENT_TYPES } from "@vibe/protocol";

export function listedEngineCommandTypes(): readonly string[] {
  return ENGINE_COMMAND_TYPES;
}

export function listedUIEventTypes(): readonly string[] {
  return UI_EVENT_TYPES;
}
