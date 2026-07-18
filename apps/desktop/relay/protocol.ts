// Relay-only message contract (NOT part of the engine host NDJSON protocol).
// The relay is a desktop-side presentation shell component, so terminal access
// — a shell feature, not an engine feature — lives here. These frames ride the
// same WebSocket as the host protocol, namespaced by the `relay` field so they
// never collide with `type`-keyed host frames. The shared `terminal.ts` types
// (TerminalEvent / TerminalOpenResult / TerminalCommandResult) are reused so the
// PTY contract is identical to the Electron main's terminal-manager.
import type { TerminalEvent, TerminalOpenResult, TerminalCommandResult } from "../src/shared/terminal.js";
import type { ConfigReadResult, ConfigScope, ConfigWriteRequest, MemoryFileRequest, MemoryFileResult, MemoryWriteRequest } from "../src/shared/config-schema.js";
import type {
  GitCheckoutRequest, GitCommitRequest, GitCreateBranchRequest, GitDeleteBranchRequest,
  GhPrCreateRequest, GhPrSummary, GitFullStatus, GitMergeRequest, GitPullRequest, GitPushRequest,
} from "../src/shared/git-types.js";
import type { CloudFailureDetails, CloudProviderId, CloudSessionCatalogEntry, CloudSettingsPublic, CloudStatusEvent, ProviderCredentials } from "../src/shared/cloud.js";
import { parseCloudSettingsPatch, type CloudSettingsPatch } from "../src/shared/cloud-settings.js";

export const MOBILE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const MOBILE_UPLOAD_MAX_BASE64_CHARS = Math.ceil(MOBILE_UPLOAD_MAX_BYTES / 3) * 4;

export type MobileUploadResult =
  | { ok: true; path: string; name: string; size: number; mimeType?: string }
  | { ok: false; error: string };

export type GitRelayRequest =
  | { action: "status"; cwd: string }
  | { action: "createBranch"; request: GitCreateBranchRequest }
  | { action: "checkout"; request: GitCheckoutRequest }
  | { action: "deleteBranch"; request: GitDeleteBranchRequest }
  | { action: "stage"; request: { cwd: string; paths?: string[]; all?: boolean; allIncludingUntracked?: boolean } }
  | { action: "unstage"; request: { cwd: string; paths?: string[] } }
  | { action: "commit"; request: GitCommitRequest }
  | { action: "merge"; request: GitMergeRequest }
  | { action: "push"; request: GitPushRequest }
  | { action: "pull"; request: GitPullRequest }
  | { action: "fetch"; request: { cwd: string; remote?: string } }
  | { action: "ghAvailable"; cwd: string }
  | { action: "prList"; cwd: string }
  | { action: "prCreate"; request: GhPrCreateRequest };

export type GitRelayResult =
  | { ok: true; status: GitFullStatus | null }
  | { ok: true; available: boolean }
  | { ok: true; prs: GhPrSummary[] }
  | { ok: true; url?: string; message?: string }
  | { ok: true; message?: string }
  | { ok: false; error: string };

export type CloudRelayRequest =
  | { action: "settings" }
  | { action: "updateSettings"; patch: CloudSettingsPatch }
  | { action: "connect"; provider: CloudProviderId; credentials: NonNullable<ProviderCredentials[CloudProviderId]> }
  | { action: "disconnect"; provider: CloudProviderId }
  | { action: "test"; provider: CloudProviderId }
  | { action: "listSessions" }
  | { action: "saveBinding"; input: { id?: string; label: string; kind: "environment" | "file" | "brokered"; value: string } }
  | { action: "removeBinding"; id: string }
  | { action: "handoff"; request: { cwd: string; provider: CloudProviderId; instruction?: string; additionalInclusions?: string[]; includeModelCredentials?: boolean } }
  | { action: "reconnect"; sessionId: string }
  | { action: "resumeLocal"; sessionId: string; keepCloudCopy?: boolean }
  | { action: "deleteCopy"; sessionId: string }
  | { action: "recoverLost"; sessionId: string };

export type CloudRelayResult =
  | { ok: true; value?: CloudSettingsPublic | CloudSessionCatalogEntry[] | CloudSessionCatalogEntry | { ok: true; account?: string } | { ok: false; error: string } | { sessionId: string; cwd: string; divergent?: boolean; recoveryPath?: string }; sessionId?: string }
  | { ok: false; error: string; details?: CloudFailureDetails };

export type RelayInbound =
  | { relay: "term-open"; requestId: string; cwd: string; cols: number; rows: number }
  | { relay: "term-input"; requestId: string; id: string; data: string }
  | { relay: "term-resize"; requestId: string; id: string; cols: number; rows: number }
  | { relay: "term-close"; requestId: string; id: string }
  | { relay: "list-files"; requestId: string; cwd: string; query: string; limit: number }
  | { relay: "upload-file"; requestId: string; cwd: string; name: string; mimeType?: string; dataBase64: string }
  | { relay: "config-read"; requestId: string; scope: ConfigScope; cwd?: string }
  | { relay: "config-write"; requestId: string; request: ConfigWriteRequest }
  | { relay: "memory-read"; requestId: string; scope: ConfigScope; cwd?: string }
  | { relay: "memory-write"; requestId: string; request: MemoryWriteRequest }
  | { relay: "git"; requestId: string; request: GitRelayRequest }
  | { relay: "cloud"; requestId: string; request: CloudRelayRequest };

export type RelayOutbound =
  | { relay: "term-opened"; requestId: string; result: TerminalOpenResult }
  | { relay: "term-event"; event: TerminalEvent }
  | { relay: "term-command"; requestId: string; result: TerminalCommandResult }
  | { relay: "term-closed"; requestId: string; id: string }
  | { relay: "files"; requestId: string; paths: string[] }
  | { relay: "upload-result"; requestId: string; result: MobileUploadResult }
  | { relay: "config-read-result"; requestId: string; result: ConfigReadResult | { ok: false; error: string } }
  | { relay: "config-write-result"; requestId: string; result: { ok: true; config: Record<string, unknown> } | { ok: false; error: string } }
  | { relay: "memory-read-result"; requestId: string; result: MemoryFileResult | { ok: false; error: string } }
  | { relay: "memory-write-result"; requestId: string; result: { ok: true } | { ok: false; error: string } }
  | { relay: "git-result"; requestId: string; result: GitRelayResult }
  | { relay: "cloud-result"; requestId: string; result: CloudRelayResult }
  | { relay: "cloud-status"; event: CloudStatusEvent };

export function isRelayInbound(value: unknown): value is RelayInbound {
  const v = relayRecord(value);
  if (!v) return false;
  if (typeof v.relay !== "string") return false;
  if (!relayRequestId(v.requestId)) return false;
  if (v.relay === "git") return isGitRelayRequest(v.request);
  if (v.relay === "cloud") return isCloudRelayRequest(v.request);
  if (v.relay === "term-open") return relayString(v.cwd, 32_768) && relayDimension(v.cols) && relayDimension(v.rows);
  if (v.relay === "term-input") return relayString(v.id, 1_024) && typeof v.data === "string" && v.data.length <= 256 * 1_024;
  if (v.relay === "term-resize") return relayString(v.id, 1_024) && relayDimension(v.cols) && relayDimension(v.rows);
  if (v.relay === "term-close") return relayString(v.id, 1_024);
  if (v.relay === "list-files") return relayString(v.cwd, 32_768) && typeof v.query === "string" && v.query.length <= 4_096
    && Number.isSafeInteger(v.limit) && (v.limit as number) >= 1 && (v.limit as number) <= 200;
  if (v.relay === "upload-file") return relayString(v.cwd, 32_768)
    && relayString(v.name, 255)
    && (v.mimeType === undefined || relayString(v.mimeType, 255))
    && isBoundedCanonicalBase64(v.dataBase64);
  if (v.relay === "config-read" || v.relay === "memory-read") return relayScope(v.scope) && relayOptionalCwd(v.cwd);
  if (v.relay === "config-write") {
    const request = relayRecord(v.request);
    return !!request && relayScope(request.scope) && relayOptionalCwd(request.cwd) && !!relayRecord(request.patch);
  }
  if (v.relay === "memory-write") {
    const request = relayRecord(v.request);
    return !!request && relayScope(request.scope) && relayOptionalCwd(request.cwd)
      && typeof request.content === "string" && request.content.length <= 4 * 1_024 * 1_024;
  }
  return false;
}

function isCloudRelayRequest(value: unknown): value is CloudRelayRequest {
  const request = relayRecord(value);
  if (!request) return false;
  if (typeof request.action !== "string") return false;
  if (request.action === "settings" || request.action === "listSessions") return true;
  if (request.action === "updateSettings") {
    try { parseCloudSettingsPatch(request.patch); return true; } catch { return false; }
  }
  if (request.action === "connect") {
    const credentials = relayRecord(request.credentials);
    if (!isCloudProvider(request.provider) || !credentials) return false;
    return request.provider === "e2b"
      ? relayString(credentials.apiKey, 16_384)
      : (credentials.token === undefined || credentials.token === "" || relayString(credentials.token, 16_384))
        && (credentials.teamId === undefined || credentials.teamId === "" || relayString(credentials.teamId, 1_024))
        && (credentials.projectId === undefined || credentials.projectId === "" || relayString(credentials.projectId, 1_024))
        && (!(typeof credentials.projectId === "string" && credentials.projectId.length > 0)
          || typeof credentials.teamId === "string" && credentials.teamId.length > 0);
  }
  if (request.action === "disconnect" || request.action === "test") return isCloudProvider(request.provider);
  if (request.action === "saveBinding") {
    const input = relayRecord(request.input);
    return !!input && (input.id === undefined || relayString(input.id, 1_024))
      && relayString(input.label, 1_024) && input.kind === "environment" && relayString(input.value, 256 * 1_024);
  }
  if (request.action === "removeBinding") return typeof request.id === "string" && request.id.length > 0;
  if (request.action === "handoff") {
    const handoff = relayRecord(request.request);
    return !!handoff && relayString(handoff.cwd, 32_768) && isCloudProvider(handoff.provider)
      && (handoff.instruction === undefined || typeof handoff.instruction === "string" && handoff.instruction.length <= 256 * 1_024)
      && (handoff.includeModelCredentials === undefined || typeof handoff.includeModelCredentials === "boolean")
      && (handoff.additionalInclusions === undefined || Array.isArray(handoff.additionalInclusions)
        && handoff.additionalInclusions.length <= 128 && handoff.additionalInclusions.every((item) => relayString(item, 32_768)));
  }
  if (request.action === "reconnect" || request.action === "deleteCopy" || request.action === "recoverLost") return relayString(request.sessionId, 1_024);
  if (request.action === "resumeLocal") return relayString(request.sessionId, 1_024)
    && (request.keepCloudCopy === undefined || typeof request.keepCloudCopy === "boolean");
  return false;
}

function isCloudProvider(value: unknown): value is CloudProviderId { return value === "e2b" || value === "vercel"; }

function relayRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function relayString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars && !value.includes("\0");
}

export function isBoundedCanonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MOBILE_UPLOAD_MAX_BASE64_CHARS || value.length % 4 !== 0) return false;
  let dataEnd = value.length;
  if (value.endsWith("==")) dataEnd -= 2;
  else if (value.endsWith("=")) dataEnd -= 1;
  for (let index = 0; index < dataEnd; index++) {
    const code = value.charCodeAt(index);
    const valid = code >= 65 && code <= 90
      || code >= 97 && code <= 122
      || code >= 48 && code <= 57
      || code === 43
      || code === 47;
    if (!valid) return false;
  }
  for (let index = dataEnd; index < value.length; index++) if (value[index] !== "=") return false;
  return true;
}

function relayRequestId(value: unknown): value is string { return relayString(value, 1_024); }

function relayDimension(value: unknown): boolean {
  return Number.isFinite(value) && (value as number) >= 1 && (value as number) <= 1_000;
}

function relayScope(value: unknown): value is ConfigScope { return value === "global" || value === "project"; }

function relayOptionalCwd(value: unknown): boolean { return value === undefined || relayString(value, 32_768); }

function isGitRelayRequest(value: unknown): value is GitRelayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (typeof request.action !== "string") return false;
  if (request.action === "status" || request.action === "ghAvailable" || request.action === "prList") return typeof request.cwd === "string" && request.cwd.length > 0;
  const nested = request.request;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return false;
  if (typeof (nested as Record<string, unknown>).cwd !== "string") return false;
  return request.action === "createBranch" || request.action === "checkout" || request.action === "deleteBranch" || request.action === "stage" || request.action === "unstage" || request.action === "commit" || request.action === "merge" || request.action === "push" || request.action === "pull" || request.action === "fetch" || request.action === "prCreate";
}
export function isRelayOutbound(value: unknown): value is RelayOutbound {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.relay !== "string") return false;
  if (v.relay === "term-event" || v.relay === "cloud-status") return true;
  return relayRequestId(v.requestId) && (v.relay === "term-opened" || v.relay === "term-command" || v.relay === "term-closed" || v.relay === "files" || v.relay === "upload-result" || v.relay === "config-read-result" || v.relay === "config-write-result" || v.relay === "memory-read-result" || v.relay === "memory-write-result" || v.relay === "git-result" || v.relay === "cloud-result");
}
