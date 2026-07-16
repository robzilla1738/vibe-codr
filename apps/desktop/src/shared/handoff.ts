import type { ExecutionTarget, PendingCapabilityRequest } from "./cloud";
export type { ExecutionTarget } from "./cloud";

export interface PortableSessionFileV1 {
  path: string;
  bytes: number;
  sha256: string;
  contentBase64: string;
}

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
