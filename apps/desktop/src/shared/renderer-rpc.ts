import type { RpcMethod } from "./protocol";

const RENDERER_RPC_METHODS = new Set<RpcMethod>([
  "snapshot",
  "listModels",
  "listProviders",
  "listAgents",
  "listSkills",
  "listMcp",
  "providerAuthStatus",
  "beginProviderAuth",
  "cancelProviderAuth",
  "logoutProviderAuth",
  "finalize",
  "listSessions",
  "listProjects",
  "renameProject",
  "archiveProject",
  "deleteProject",
  "renameSession",
  "deleteSession",
  "archiveSession",
]);

export function isRendererRpcMethod(method: RpcMethod): boolean {
  return RENDERER_RPC_METHODS.has(method);
}
