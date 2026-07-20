import { validateRpcResult, type RpcMethod } from "@vibe/protocol/host-v2";

/** Host RPC results use the canonical method-specific result registry. */
export function isRpcResult(method: RpcMethod, value: unknown): boolean {
  return validateRpcResult(method, value);
}
