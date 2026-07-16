import type { PortableSessionArchiveV1 } from "./handoff";

export type CloudProviderId = "e2b" | "vercel";

export type ExecutionTarget =
  | { kind: "local" }
  | { kind: "cloud"; provider: CloudProviderId };

export type CloudSessionStatus =
  | "preparing"
  | "transferring"
  | "starting"
  | "running"
  | "needs-local"
  | "suspended"
  | "syncing-back"
  | "cleanup-pending"
  | "handoff-interrupted"
  | "lost"
  | "recoverable-error";

export function isCloudSessionRemoteOwned(status: CloudSessionStatus): boolean {
  return status !== "suspended" && status !== "cleanup-pending" && status !== "handoff-interrupted" && status !== "lost";
}

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

export interface WorkspaceFileEntryV1 {
  path: string;
  type: "file" | "symlink";
  bytes: number;
  mode: number;
  sha256: string;
  linkTarget?: string;
}

export interface WorkspaceTransferManifestV1 {
  schemaVersion: 1;
  workspaceId: string;
  sessionId: string;
  ownershipGeneration: number;
  engineRevision: string;
  sourceRoot: string;
  sourceRootFingerprint: string;
  git: {
    isRepository: boolean;
    head: string | null;
    branch: string | null;
    indexHash?: string;
    bundlePath?: string;
    stagedPatchPath?: string;
    worktreePatchPath?: string;
    deleted: string[];
    submodules: Array<{ path: string; head: string | null; bundlePath?: string }>;
    syntheticBase?: string;
  };
  entries: WorkspaceFileEntryV1[];
  portableCapabilities: string[];
  relayOnlyCapabilities: string[];
  restartableJobs: Array<{ command: string; cwd: string; envKeys: string[] }>;
  excludedPaths: Array<{ path: string; reason: string }>;
  exclusionRules: string[];
  archiveSha256: string;
  totalBytes: number;
  createdAt: number;
}

export interface WorkspaceTransferBundleV1 {
  manifest: WorkspaceTransferManifestV1;
  files: Array<{ path: string; contentBase64: string }>;
  engine: PortableSessionArchiveV1;
}

export interface ProviderCredentials {
  e2b?: { apiKey: string };
  vercel?: { token: string; teamId: string; projectId: string };
}

export interface CloudSandboxRecord {
  provider: CloudProviderId;
  id: string;
  name: string;
  status: "running" | "paused" | "stopped" | "unknown";
  createdAt?: number;
  domain?: string;
  needsDaemonRestart?: boolean;
}

export interface CloudSandboxCreateOptions {
  name: string;
  workspaceId: string;
  sessionId: string;
  vcpus?: number;
  timeoutMs?: number;
  allowedDomains?: string[];
  signal?: AbortSignal;
}

export interface CloudConnectionEndpoint {
  url: string;
  headers?: Record<string, string>;
}

export type CloudStartupStage =
  | "waiting"
  | "packaging"
  | "creating"
  | "uploading"
  | "verifying"
  | "restoring"
  | "starting-agent"
  | "checking-health"
  | "connecting";

export interface CloudStatusEvent {
  sessionId?: string;
  status: CloudSessionStatus;
  message: string;
  progress?: number;
  stage?: CloudStartupStage;
  startedAt?: number;
}

export interface CloudFailureDetails {
  code: "provider-unavailable" | "runtime-incompatible" | "setup-failed" | "daemon-exited" | "health-timeout" | "cleanup-pending";
  stage: CloudStartupStage;
  retryable: boolean;
  diagnostic?: string;
}

export interface CloudCommandOptions {
  privileged?: boolean;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CloudCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CloudCommandHandle {
  wait(): Promise<CloudCommandResult>;
  kill(): Promise<void>;
  detach(): Promise<void>;
}

export interface SandboxProvider {
  readonly id: CloudProviderId;
  connectAccount(credentials: ProviderCredentials[CloudProviderId]): Promise<void>;
  test(): Promise<{ ok: true; account?: string } | { ok: false; error: string }>;
  create(options: CloudSandboxCreateOptions): Promise<CloudSandboxRecord>;
  get(id: string): Promise<CloudSandboxRecord | null>;
  findByName(name: string): Promise<CloudSandboxRecord | null>;
  resume(id: string, timeoutMs?: number): Promise<CloudSandboxRecord | null>;
  upload(id: string, remotePath: string, data: Uint8Array, signal?: AbortSignal): Promise<void>;
  size(id: string, remotePath: string): Promise<number>;
  download(id: string, remotePath: string): Promise<Uint8Array>;
  run(id: string, command: string, args: string[], env?: Record<string, string>, options?: CloudCommandOptions): Promise<CloudCommandResult>;
  start(id: string, command: string, args: string[], env?: Record<string, string>, options?: CloudCommandOptions): Promise<CloudCommandHandle>;
  suspend(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  domain(id: string, port: number): Promise<CloudConnectionEndpoint>;
  observe(id: string, listener: (record: CloudSandboxRecord) => void): () => void;
}

export interface CloudSessionCatalogEntry {
  sessionId: string;
  model?: string;
  models?: string[];
  optionalModels?: string[];
  credentialEnvironment?: string[];
  providerDomains?: string[];
  workspaceId: string;
  sourceRoot: string;
  provider: CloudProviderId;
  sandboxId: string;
  sandboxName: string;
  ownershipGeneration: number;
  status: CloudSessionStatus;
  baseFingerprint: string;
  baseHead?: string | null;
  remoteUrl?: string;
  error?: string;
  localRecoveryCwd?: string;
  localImportPending?: boolean;
  exclusionRules?: string[];
  excludedPaths?: Array<{ path: string; reason: string }>;
  handoffTransition?: {
    direction: "local-to-cloud" | "cloud-to-local";
    target: ExecutionTarget;
    phase: "intent" | "prepared" | "committing";
    nonce?: string;
    ownershipGeneration?: number;
    localCwd?: string;
    portableImported?: boolean;
    applied?: { kind: "applied" | "diverged"; path: string };
    startedAt: number;
  };
  updatedAt: number;
}

/**
 * Resolve the latest session across the local project index and the cloud
 * catalog, returning a cloud entry only when that exact latest session is
 * remotely owned. This prevents opening a project from reconnecting an
 * arbitrary older cloud session merely because one exists for the workspace.
 */
export function latestRemoteOwnedCloudSession(
  cloudEntries: CloudSessionCatalogEntry[],
  localSessions: Array<{ id: string; updatedAt: number }>,
): CloudSessionCatalogEntry | undefined {
  const candidates = new Map<string, { updatedAt: number; cloud?: CloudSessionCatalogEntry }>();
  for (const session of localSessions) {
    candidates.set(session.id, { updatedAt: session.updatedAt });
  }
  for (const entry of cloudEntries) {
    if (!isCloudSessionRemoteOwned(entry.status)) continue;
    const current = candidates.get(entry.sessionId);
    candidates.set(entry.sessionId, {
      updatedAt: Math.max(current?.updatedAt ?? 0, entry.updatedAt),
      cloud: entry,
    });
  }
  const latest = [...candidates.entries()].sort(
    ([leftId, left], [rightId, right]) => right.updatedAt - left.updatedAt || rightId.localeCompare(leftId),
  )[0]?.[1];
  return latest?.cloud;
}

export interface CloudSettingsPublic {
  experimentalEnabled: boolean;
  lastProvider: CloudProviderId;
  autoPauseMinutes: number;
  deleteOnReturn: boolean;
  providers: Record<CloudProviderId, { configured: boolean; account?: string; lastTest?: number; error?: string }>;
  credentialBindings: Array<{ id: string; label: string; kind: "environment" | "file" | "brokered"; ready: boolean }>;
  allowedDomains: string[];
  additionalExclusions: string[];
}
