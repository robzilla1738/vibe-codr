import {
  EngineSnapshotSchema,
  ProjectSummarySchema,
  UIEventSchema,
  validateRpcResult,
  type EngineSnapshot,
  type ProjectSummary,
  type RpcMethod,
  type UIEvent,
} from "@vibe/protocol";

// Compatibility exports retained for callers/tests during the facade release.
// Enforcement now belongs to the canonical result schemas.
export const RPC_CATALOG_MAX_ITEMS = 20_000;
export const RPC_CATALOG_FIELD_MAX_CHARS = 16 * 1_024;
export const RPC_CATALOG_ERROR_MAX_CHARS = 64 * 1_024;
export const RPC_PROVIDER_ENV_MAX_ITEMS = 64;
export const RPC_PROVIDER_ENV_MAX_CHARS = 1_024;

/** Validate a direct/in-process snapshot, which need not carry host replay cursors. */
export function isEngineSnapshot(value: unknown): value is EngineSnapshot {
  return EngineSnapshotSchema.safeParse(value).success;
}

export function isProjectSummaryArray(value: unknown): value is ProjectSummary[] {
  return Array.isArray(value)
    && value.every((project) => ProjectSummarySchema.safeParse(project).success);
}

/** Host RPC results use the canonical method-specific result registry. */
export function isRpcResult(method: RpcMethod, value: unknown): boolean {
  return validateRpcResult(method, value);
}

/** Renderer events use the same canonical schema that validates host event frames. */
export function isRenderableUIEvent(value: UIEvent): boolean {
  return UIEventSchema.safeParse(value).success;
}
