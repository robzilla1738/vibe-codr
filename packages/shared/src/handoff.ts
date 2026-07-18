/** Portable execution target selected for a session. */
export type ExecutionTarget =
  | { kind: "local" }
  | { kind: "cloud"; provider: "e2b" | "vercel" };

export type CloudSessionStatus =
  | "preparing"
  | "transferring"
  | "starting"
  | "running"
  | "needs-local"
  | "suspended"
  | "syncing-back"
  | "recoverable-error";

export interface PendingCapabilityRequest {
  id: string;
  integration: string;
  toolName: string;
  arguments: unknown;
  approvalScope: "once" | "session" | "integration";
  originatingTurn: string;
  status: "pending" | "approved" | "denied" | "resolved";
  createdAt: number;
  result?: unknown;
  error?: string;
}

export interface ExternalCapabilityResolution {
  id: string;
  status: "denied" | "resolved";
  result?: unknown;
  error?: string;
}

export interface PortableSessionFileV1 {
  path: string;
  bytes: number;
  sha256: string;
  contentBase64: string;
}

/** Engine-owned state only. Workspace bytes travel in WorkspaceTransferManifestV1. */
export interface PortableSessionArchiveV1 {
  schemaVersion: 1;
  sessionId: string;
  sourceRoot: string;
  sourceStateRoot: string;
  ownershipGeneration: number;
  executionTarget: ExecutionTarget;
  engineRevision: string;
  createdAt: number;
  files: PortableSessionFileV1[];
  pendingCapabilities: PendingCapabilityRequest[];
  archiveSha256: string;
}

export interface HandoffPreparation {
  sessionId: string;
  ownershipGeneration: number;
  previousGeneration: number;
  nonce: string;
  target: ExecutionTarget;
  preparedAt: number;
}
