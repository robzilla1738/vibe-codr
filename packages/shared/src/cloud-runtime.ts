import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const CLOUD_RUNTIME_PROFILE_VERSION = 1 as const;
export const CLOUD_MODEL_ACCESS_VERSION = 1 as const;
export const CLOUD_RUNTIME_REVISION = "cloud-runtime-profile-v1";

const MAX_ENVIRONMENT_NAMES = 64;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const MAX_REQUIRED_MODELS = 32;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODEL_NAME = /^[^/\s]{1,128}\/[\S]{1,384}$/;

export type CloudRuntimeErrorCode =
  | "missing-credential"
  | "invalid-credential"
  | "runtime-profile-mismatch"
  | "legacy-session-repair-failed";

export class CloudRuntimeContractError extends Error {
  constructor(readonly code: CloudRuntimeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CloudRuntimeContractError";
  }
}

export interface CloudRuntimeProfileV1 {
  schemaVersion: 1;
  theme: string;
  accentColor?: string;
  details: "quiet" | "normal" | "verbose";
  requiredModels: string[];
  recoveryOnly?: true;
}

export interface CloudModelAccessEnvelopeV1 {
  schemaVersion: 1;
  sessionId: string;
  algorithm: "aes-256-gcm";
  environmentNames: string[];
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface CloudModelAccessPayloadV1 {
  schemaVersion: 1;
  environment: Record<string, string>;
  profile: CloudRuntimeProfileV1;
}

export function createCloudRuntimeProfile(input: Omit<CloudRuntimeProfileV1, "schemaVersion">): CloudRuntimeProfileV1 {
  return validateCloudRuntimeProfile({ schemaVersion: 1, ...input });
}

export function sealCloudModelAccess(
  sessionId: string,
  accessToken: string,
  environment: Record<string, string>,
  profile: CloudRuntimeProfileV1,
): CloudModelAccessEnvelopeV1 {
  assertSessionAndToken(sessionId, accessToken);
  const checkedEnvironment = validateEnvironment(environment);
  const checkedProfile = validateCloudRuntimeProfile(profile);
  const environmentNames = Object.keys(checkedEnvironment).sort();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(accessToken, sessionId), iv);
  cipher.setAAD(aad(sessionId, environmentNames));
  const payload: CloudModelAccessPayloadV1 = {
    schemaVersion: 1,
    environment: checkedEnvironment,
    profile: checkedProfile,
  };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    schemaVersion: 1,
    sessionId,
    algorithm: "aes-256-gcm",
    environmentNames,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function openCloudModelAccess(
  envelope: unknown,
  accessToken: string,
  expectedSessionId?: string,
): CloudModelAccessPayloadV1 {
  const checked = validateEnvelope(envelope);
  assertSessionAndToken(checked.sessionId, accessToken);
  if (expectedSessionId && checked.sessionId !== expectedSessionId) {
    throw new CloudRuntimeContractError("runtime-profile-mismatch", "Cloud model access belongs to a different session");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(accessToken, checked.sessionId),
      Buffer.from(checked.iv, "base64"),
    );
    decipher.setAAD(aad(checked.sessionId, checked.environmentNames));
    decipher.setAuthTag(Buffer.from(checked.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(checked.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as Partial<CloudModelAccessPayloadV1>;
    if (parsed.schemaVersion !== 1) throw new Error("payload version");
    const environment = validateEnvironment(parsed.environment);
    const names = Object.keys(environment).sort();
    if (names.length !== checked.environmentNames.length || names.some((name, index) => name !== checked.environmentNames[index])) {
      throw new Error("credential scope");
    }
    return { schemaVersion: 1, environment, profile: validateCloudRuntimeProfile(parsed.profile) };
  } catch (error) {
    if (error instanceof CloudRuntimeContractError) throw error;
    throw new CloudRuntimeContractError("invalid-credential", "Cloud model access could not be authenticated");
  }
}

export function terminalEnvironmentWithoutModelAccess(
  baseline: NodeJS.ProcessEnv | Record<string, string>,
  modelEnvironmentNames: readonly string[],
): Record<string, string> {
  const blocked = new Set([
    ...modelEnvironmentNames,
    "VIBE_CLOUD_ACCESS_TOKEN",
    "VIBE_CLOUD_ACCESS_TOKEN_FILE",
    "VIBE_CLOUD_MODEL_ACCESS_FILE",
  ]);
  return Object.fromEntries(
    Object.entries(baseline).filter(([name, value]) => !blocked.has(name) && typeof value === "string"),
  ) as Record<string, string>;
}

export function validateRequiredModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_REQUIRED_MODELS) {
    throw new CloudRuntimeContractError("runtime-profile-mismatch", "Cloud runtime requires a bounded model list");
  }
  const models = [...new Set(value)];
  if (!models.every((model) => typeof model === "string" && MODEL_NAME.test(model))) {
    throw new CloudRuntimeContractError("runtime-profile-mismatch", "Cloud runtime requires provider-qualified model identifiers");
  }
  return models as string[];
}

function validateCloudRuntimeProfile(value: unknown): CloudRuntimeProfileV1 {
  if (!value || typeof value !== "object") throw profileError();
  const profile = value as Partial<CloudRuntimeProfileV1>;
  if (
    profile.schemaVersion !== 1
    || typeof profile.theme !== "string"
    || profile.theme.length < 1
    || profile.theme.length > 128
    || (profile.accentColor !== undefined && (typeof profile.accentColor !== "string" || profile.accentColor.length > 128))
    || (profile.details !== "quiet" && profile.details !== "normal" && profile.details !== "verbose")
    || (profile.recoveryOnly !== undefined && profile.recoveryOnly !== true)
  ) throw profileError();
  const requiredModels = validateRequiredModels(profile.requiredModels);
  if (!requiredModels.length && profile.recoveryOnly !== true) throw profileError();
  return {
    schemaVersion: 1,
    theme: profile.theme,
    ...(profile.accentColor ? { accentColor: profile.accentColor } : {}),
    details: profile.details,
    requiredModels,
    ...(profile.recoveryOnly === true ? { recoveryOnly: true } : {}),
  };
}

function validateEnvelope(value: unknown): CloudModelAccessEnvelopeV1 {
  if (!value || typeof value !== "object") throw profileError();
  const envelope = value as Partial<CloudModelAccessEnvelopeV1>;
  if (
    envelope.schemaVersion !== 1
    || envelope.algorithm !== "aes-256-gcm"
    || typeof envelope.sessionId !== "string"
    || envelope.sessionId.length < 1
    || envelope.sessionId.length > 1024
    || !Array.isArray(envelope.environmentNames)
    || envelope.environmentNames.length > MAX_ENVIRONMENT_NAMES
    || !envelope.environmentNames.every((name) => typeof name === "string" && ENVIRONMENT_NAME.test(name))
    || new Set(envelope.environmentNames).size !== envelope.environmentNames.length
    || typeof envelope.iv !== "string"
    || Buffer.from(envelope.iv, "base64").byteLength !== 12
    || typeof envelope.authTag !== "string"
    || Buffer.from(envelope.authTag, "base64").byteLength !== 16
    || typeof envelope.ciphertext !== "string"
    || Buffer.byteLength(envelope.ciphertext, "base64") > MAX_ENVIRONMENT_BYTES * 2
  ) throw profileError();
  return envelope as CloudModelAccessEnvelopeV1;
}

function validateEnvironment(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudRuntimeContractError("invalid-credential", "Cloud model access environment is invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ENVIRONMENT_NAMES) throw new CloudRuntimeContractError("invalid-credential", "Cloud model access scope is too large");
  let bytes = 0;
  for (const [name, secret] of entries) {
    if (!ENVIRONMENT_NAME.test(name) || typeof secret !== "string" || !secret || Buffer.byteLength(secret) > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new CloudRuntimeContractError("invalid-credential", `Cloud credential ${name || "name"} is invalid`);
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(secret);
  }
  if (bytes > MAX_ENVIRONMENT_BYTES) throw new CloudRuntimeContractError("invalid-credential", "Cloud model access payload is too large");
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function assertSessionAndToken(sessionId: string, accessToken: string): void {
  if (!sessionId || sessionId.length > 1024) throw profileError();
  if (!accessToken || accessToken.length < 32) {
    throw new CloudRuntimeContractError("missing-credential", "Cloud session access token is unavailable");
  }
}

function deriveKey(accessToken: string, sessionId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(accessToken), Buffer.from(sessionId), Buffer.from("vibe-cloud-model-access-v1"), 32));
}

function aad(sessionId: string, environmentNames: string[]): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, sessionId, environmentNames }));
}

function profileError(): CloudRuntimeContractError {
  return new CloudRuntimeContractError("runtime-profile-mismatch", "Cloud runtime profile is incompatible");
}
