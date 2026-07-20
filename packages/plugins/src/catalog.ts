import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import {
  deepFreeze,
  isExactPluginVersion,
  parsePluginManifest,
  type PluginCapability,
  type PluginManifestV1,
} from "./manifest.ts";

export type CatalogArtifactSource = "npm" | "https";
export type CatalogEntryKind = "plugin" | "skill" | "mcp";

export interface CatalogEntryV1 {
  kind: CatalogEntryKind;
  id: string;
  version: string;
  artifact: { source: CatalogArtifactSource; locator: string; integrity: string };
  requiredCapabilities: PluginCapability[];
  manifest?: PluginManifestV1;
}

export interface VerifiedCatalogV1 {
  schemaVersion: 1;
  generatedAt: string;
  signingKeyId: string;
  entries: readonly CatalogEntryV1[];
}

export type TrustedCatalogKeys = ReadonlyMap<string, string | Uint8Array | KeyObject>;

const MAX_CATALOG_BYTES = 1_048_576;
const MAX_ENTRIES = 1_000;
const ID = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Verify a canonical Ed25519-signed curated catalog. This function only
 * validates and returns immutable review data; it never fetches or installs. */
export function verifyCatalogIndex(input: string | Uint8Array, trustedKeys: TrustedCatalogKeys): VerifiedCatalogV1 {
  const bytes = typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
  if (bytes.byteLength > MAX_CATALOG_BYTES) throw new Error("Plugin catalog exceeds the 1 MiB limit");
  if (bytes.includes(0)) throw new Error("Plugin catalog contains NUL bytes");
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Plugin catalog is not valid JSON"); }
  if (!isRecord(raw) || !hasOnly(raw, ["schemaVersion", "generatedAt", "entries", "signing"]))
    throw new Error("Invalid PluginCatalogV1 envelope");
  if (raw.schemaVersion !== 1 || !isTimestamp(raw.generatedAt) || !Array.isArray(raw.entries) || raw.entries.length > MAX_ENTRIES)
    throw new Error("Invalid PluginCatalogV1 fields");
  if (!isRecord(raw.signing) || !hasOnly(raw.signing, ["algorithm", "keyId", "signature"])
    || raw.signing.algorithm !== "ed25519" || !isBounded(raw.signing.keyId, 1, 128)
    || !isCanonicalBase64(raw.signing.signature, 64)) throw new Error("Plugin catalog has an invalid signature envelope");
  const trusted = trustedKeys.get(raw.signing.keyId);
  if (!trusted) throw new Error(`Unknown plugin catalog signing key: ${raw.signing.keyId}`);
  const payload = canonicalCatalogBytes({ schemaVersion: 1, generatedAt: raw.generatedAt, entries: raw.entries });
  const key = trusted instanceof Uint8Array && !(trusted instanceof Buffer)
    ? createPublicKey({ key: Buffer.from(trusted), format: "der", type: "spki" })
    : typeof trusted === "string" || Buffer.isBuffer(trusted) ? createPublicKey(trusted) : trusted;
  if (!verifySignature(null, payload, key, Buffer.from(raw.signing.signature, "base64")))
    throw new Error("Plugin catalog signature verification failed");

  const entries = raw.entries.map(parseCatalogEntry);
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = `${entry.kind}:${entry.id}@${entry.version}`;
    if (identities.has(identity)) throw new Error(`Duplicate plugin catalog entry: ${identity}`);
    identities.add(identity);
  }
  return deepFreeze({ schemaVersion: 1, generatedAt: raw.generatedAt, signingKeyId: raw.signing.keyId, entries });
}

/** Deterministic JSON bytes used by catalog publishers and verifiers. */
export function canonicalCatalogBytes(value: unknown): Buffer {
  return Buffer.from(stableJson(value), "utf8");
}

function parseCatalogEntry(value: unknown): CatalogEntryV1 {
  if (!isRecord(value) || !hasOnly(value, ["kind", "id", "version", "artifact", "requiredCapabilities", "manifest"]))
    throw new Error("Invalid plugin catalog entry");
  if (value.kind !== "plugin" && value.kind !== "skill" && value.kind !== "mcp") throw new Error("Unknown plugin catalog entry kind");
  if (!isBounded(value.id, 1, 200) || !ID.test(value.id) || unsafeLocator(value.id)) throw new Error("Invalid plugin catalog identity");
  if (!isExactPluginVersion(value.version)) throw new Error(`Catalog entry ${value.id} must use an exact version`);
  const artifact = parseArtifact(value.artifact, value.id, value.version);
  if (!Array.isArray(value.requiredCapabilities)) throw new Error(`Catalog entry ${value.id} has invalid capabilities`);
  // Reuse the strict manifest capability parser with a synthetic manifest. It
  // keeps catalog and plugin capability vocabularies impossible to drift.
  const capabilityProbe = parsePluginManifest({
    schemaVersion: 1, name: value.id, version: value.version, apiVersion: 1,
    contributions: [], requiredCapabilities: value.requiredCapabilities,
    provenance: { source: "npm", package: value.id },
  });
  if (!capabilityProbe.manifest) throw new Error(capabilityProbe.error ?? `Catalog entry ${value.id} has invalid capabilities`);
  let manifest: PluginManifestV1 | undefined;
  if (value.kind === "plugin") {
    const parsed = parsePluginManifest(value.manifest);
    if (!parsed.manifest) throw new Error(parsed.error ?? `Plugin catalog entry ${value.id} requires a manifest`);
    manifest = parsed.manifest;
    if (manifest.name !== value.id || manifest.version !== value.version)
      throw new Error(`Plugin catalog manifest mismatch for ${value.id}@${value.version}`);
    if (stableJson(manifest.requiredCapabilities) !== stableJson(capabilityProbe.manifest.requiredCapabilities))
      throw new Error(`Plugin catalog capability mismatch for ${value.id}@${value.version}`);
  } else if (value.manifest !== undefined) {
    throw new Error(`${value.kind} catalog entries cannot carry a plugin manifest`);
  }
  return deepFreeze({
    kind: value.kind,
    id: value.id,
    version: value.version,
    artifact,
    requiredCapabilities: capabilityProbe.manifest.requiredCapabilities,
    ...(manifest ? { manifest } : {}),
  });
}

function parseArtifact(value: unknown, id: string, version: string): CatalogEntryV1["artifact"] {
  if (!isRecord(value) || !hasOnly(value, ["source", "locator", "integrity"])
    || (value.source !== "npm" && value.source !== "https") || !isBounded(value.locator, 1, 2048)
    || unsafeLocator(value.locator) || !isSri(value.integrity)) throw new Error(`Invalid artifact for ${id}@${version}`);
  if (value.source === "npm" && value.locator !== `${id}@${version}`)
    throw new Error(`NPM artifact must pin ${id}@${version}`);
  if (value.source === "https") {
    let url: URL;
    try { url = new URL(value.locator); } catch { throw new Error(`Invalid HTTPS artifact for ${id}@${version}`); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error(`Invalid HTTPS artifact for ${id}@${version}`);
  }
  return { source: value.source, locator: value.locator, integrity: value.integrity };
}

function isSri(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("sha512-")) return false;
  return isCanonicalBase64(value.slice(7), 64);
}

function isCanonicalBase64(value: unknown, byteLength: number): value is string {
  if (typeof value !== "string" || !BASE64.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === byteLength && decoded.toString("base64") === value;
}

function unsafeLocator(value: string): boolean {
  return value.includes("\0") || value.includes("\\") || value.split(/[/?#]/).includes("..");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Catalog contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Catalog contains an unsupported JSON value");
}

function isTimestamp(value: unknown): value is string {
  return isBounded(value, 20, 40) && Number.isFinite(Date.parse(value));
}

function isBounded(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && !value.includes("\0");
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
