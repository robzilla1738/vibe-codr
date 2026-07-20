import {
  isEngineSnapshot as isCanonicalEngineSnapshot,
  isProjectSummaryArray as isCanonicalProjectSummaryArray,
  isUIEvent,
} from "@vibe/protocol/client-runtime";
import type { EngineSnapshot, UIEvent } from "@vibe/protocol/domain";
import type { ProjectSummary } from "@vibe/protocol/project";

// Compatibility exports retained for callers/tests during the facade release.
// Enforcement now belongs to the canonical result schemas.
export const RPC_CATALOG_MAX_ITEMS = 20_000;
export const RPC_CATALOG_FIELD_MAX_CHARS = 16 * 1_024;
export const RPC_CATALOG_ERROR_MAX_CHARS = 64 * 1_024;
export const RPC_PROVIDER_ENV_MAX_ITEMS = 64;
export const RPC_PROVIDER_ENV_MAX_CHARS = 1_024;

/** Validate a direct/in-process snapshot, which need not carry host replay cursors. */
export function isEngineSnapshot(value: unknown): value is EngineSnapshot {
  return isCanonicalEngineSnapshot(value);
}

export function isProjectSummaryArray(value: unknown): value is ProjectSummary[] {
  return isCanonicalProjectSummaryArray(value);
}

/** Renderer events use the dependency-free canonical client validator. */
export function isRenderableUIEvent(value: UIEvent): boolean {
  return isUIEvent(value);
}
