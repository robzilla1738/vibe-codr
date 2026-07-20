import {
  ENGINE_COMMAND_TYPES,
  HOST_PROTOCOL_CAPABILITIES,
  HOST_PROTOCOL_VERSION,
  UI_EVENT_TYPES,
  decodeInbound,
  decodeOutbound,
  isUIEvent,
  type EngineCommand,
  type HostInbound as CanonicalHostInbound,
  type HostRpcParams,
  type RpcMethod,
} from "@vibe/protocol";

/**
 * One-release compatibility facade for Electron renderer/mobile imports.
 * Schema and discriminator authority lives exclusively in @vibe/protocol.
 */
export {
  ENGINE_COMMAND_SCHEMAS,
  ENGINE_COMMAND_TYPES,
  EngineCommandSchema,
  HOST_INBOUND_FRAME_SCHEMAS,
  HOST_INBOUND_OPS,
  HOST_OUTBOUND_FRAME_SCHEMAS,
  HOST_OUTBOUND_TYPES,
  HOST_PROTOCOL_CAPABILITIES,
  HOST_PROTOCOL_VERSION,
  HOST_RPC_SCHEMAS,
  HostBootstrapSchema,
  HostEventFrameSchema,
  HostInboundSchema,
  HostOutboundSchema,
  HostReadyFrameSchema,
  HostReplayResultSchema,
  HostSnapshotSchema,
  RPC_METHODS,
  UI_EVENT_SCHEMAS,
  UI_EVENT_TYPES,
  UIEventSchema,
  decodeInbound,
  decodeOutbound,
  isUIEvent,
  validateRpcResult,
} from "@vibe/protocol";

export type {
  EngineCommand,
  HostBootstrap,
  HostEventFrame,
  HostOutbound,
  HostProtocolCapability,
  HostReplayResult,
  HostRpcMethodParams,
  HostRpcMethodResult,
  HostRpcParams,
  HostRpcRequest,
  HostSnapshot,
  PluginStatus,
  ProjectSessionSummary,
  ProjectSummary,
  RpcMethod,
  SessionSearchHit,
  UIEvent,
} from "@vibe/protocol";

/**
 * Compatibility view used by existing generic RPC forwarding code. Canonical
 * method/parameter correlation is still enforced by HostInboundSchema.
 */
export type HostInbound =
  | Exclude<CanonicalHostInbound, { op: "rpc" }>
  | { op: "rpc"; id: number; method: RpcMethod; params?: HostRpcParams };

export type PluginContributionType = import("@vibe/protocol").PluginStatus[
  "declaredContributions"
][number];

export function listedUIEventTypes(): readonly import("@vibe/protocol").UIEventType[] {
  return UI_EVENT_TYPES;
}

export function listedEngineCommandTypes(): readonly import("@vibe/protocol").EngineCommandType[] {
  return ENGINE_COMMAND_TYPES;
}

export const RUNTIME_IDENTIFIER_MAX_CHARS = 1_024;

/** Compatibility helper for renderer-local identifiers outside host frames. */
export function isRuntimeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= RUNTIME_IDENTIFIER_MAX_CHARS
    && !value.includes("\0");
}

export function encodeInbound(msg: HostInbound): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Safely below the host's one-million-character inbound line ceiling. */
export const HOST_INBOUND_SAFE_BYTES = 900_000;

/**
 * Preserve the presentation shells' actionable version-mismatch diagnostic
 * after canonical decoding rejects an incompatible ready frame.
 */
export function incompatibleHostProtocolVersion(line: string): number | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  return frame.type === "ready"
    && Number.isSafeInteger(frame.protocolVersion)
    && frame.protocolVersion !== HOST_PROTOCOL_VERSION
    ? frame.protocolVersion as number
    : null;
}

export function encodedEngineCommandBytes(command: EngineCommand): number {
  return new TextEncoder().encode(encodeInbound({ op: "send", command })).byteLength;
}

// Retain value imports in this facade so bundler regression tests exercise the
// canonical source alias in every Electron target.
void HOST_PROTOCOL_VERSION;
void HOST_PROTOCOL_CAPABILITIES;
void decodeInbound;
void decodeOutbound;
void isUIEvent;
