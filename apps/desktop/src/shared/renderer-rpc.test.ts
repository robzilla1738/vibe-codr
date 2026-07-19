import { describe, expect, it } from "vitest";
import type { RpcMethod } from "./protocol";
import { isRendererRpcMethod } from "./renderer-rpc";

describe("renderer RPC boundary", () => {
  it("allows presentation RPCs and rejects every ownership or portable-state RPC", () => {
    expect(isRendererRpcMethod("snapshot")).toBe(true);
    expect(isRendererRpcMethod("listProjects")).toBe(true);
    expect(isRendererRpcMethod("beginProviderAuth")).toBe(true);
    expect(isRendererRpcMethod("listPluginStatus")).toBe(true);
    for (const method of [
      "prepareHandoff",
      "exportPortableSession",
      "importPortableSession",
      "commitPortableImport",
      "abortPortableImport",
      "recoverLostCloudOwnership",
      "abortInterruptedHandoff",
      "commitHandoff",
      "abortHandoff",
      "exportProviderAuth",
    ] satisfies RpcMethod[]) {
      expect(isRendererRpcMethod(method)).toBe(false);
    }
  });
});
