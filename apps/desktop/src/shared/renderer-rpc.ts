import type { RpcMethod } from "./protocol";

const RENDERER_RPC_METHODS = new Set<RpcMethod>([
  "snapshot",
  "listModels",
  "listProviders",
  "listAgents",
  "listSkills",
  "listMcp",
  "listPluginStatus",
  "providerAuthStatus",
  "beginProviderAuth",
  "cancelProviderAuth",
  "logoutProviderAuth",
  "finalize",
  "listSessions",
  "searchSessions",
  "listProjects",
  "renameProject",
  "archiveProject",
  "deleteProject",
  "renameSession",
  "deleteSession",
  "archiveSession",
  "forkSession",
]);

export function isRendererRpcMethod(method: RpcMethod): boolean {
  return RENDERER_RPC_METHODS.has(method);
}
