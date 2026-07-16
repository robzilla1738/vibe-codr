import { describe, expect, it } from "vitest";
import { isCloudSessionMutationLocked, latestRemoteOwnedCloudSession, type CloudSessionCatalogEntry } from "./cloud";

function cloud(sessionId: string, updatedAt: number): CloudSessionCatalogEntry {
  return {
    sessionId,
    workspaceId: "workspace",
    sourceRoot: "/workspace",
    provider: "e2b",
    sandboxId: `sandbox-${sessionId}`,
    sandboxName: `sandbox-${sessionId}`,
    ownershipGeneration: 1,
    status: "running",
    baseFingerprint: "fingerprint",
    updatedAt,
  };
}

describe("latestRemoteOwnedCloudSession", () => {
  it("does not route an older cloud session when a newer local session exists", () => {
    expect(latestRemoteOwnedCloudSession([cloud("cloud-old", 10)], [{ id: "local-new", updatedAt: 20 }])).toBeUndefined();
  });

  it("routes the exact newest remotely owned session", () => {
    const newest = cloud("cloud-new", 30);
    expect(latestRemoteOwnedCloudSession([cloud("cloud-old", 10), newest], [{ id: "local", updatedAt: 20 }])).toBe(newest);
  });

  it("keeps cloud ownership when the same indexed session is remote", () => {
    const remote = cloud("shared", 20);
    expect(latestRemoteOwnedCloudSession([remote], [{ id: "shared", updatedAt: 25 }])).toBe(remote);
  });
});

describe("Cloud history mutation lock", () => {
  it("fails closed for remote ownership and interrupted ownership commits", () => {
    expect(isCloudSessionMutationLocked("running")).toBe(true);
    expect(isCloudSessionMutationLocked("handoff-interrupted")).toBe(true);
    expect(isCloudSessionMutationLocked("suspended")).toBe(false);
    expect(isCloudSessionMutationLocked("lost")).toBe(true);
  });
});
