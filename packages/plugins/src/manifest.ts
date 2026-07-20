import type { HookName } from "./hooks.ts";

export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_CONTRIBUTION_TYPES = ["tools", "providers", "commands", "skills", "hooks"] as const;
export type PluginContributionType = (typeof PLUGIN_CONTRIBUTION_TYPES)[number];

export const PLUGIN_CAPABILITY_TYPES = [
  "tool",
  "hook",
  "network-domain",
  "filesystem-root",
  "secret-handle",
  "provider-execution",
] as const;
export type PluginCapabilityType = (typeof PLUGIN_CAPABILITY_TYPES)[number];

export type PluginCapability =
  | { type: "tool"; name: string }
  | { type: "hook"; name: HookName }
  | { type: "network-domain"; domain: string }
  | { type: "filesystem-root"; root: string; access: "read" | "write" }
  | { type: "secret-handle"; handle: string }
  | { type: "provider-execution"; mode: "trusted-in-process-approval-required" };

export interface PluginManifestV1 {
  schemaVersion: 1;
  name: string;
  version: string;
  apiVersion: 1;
  contributions: PluginContributionType[];
  requiredCapabilities: PluginCapability[];
  provenance: { source: "npm" | "local"; package?: string };
}

const HOOK_NAMES: readonly HookName[] = [
  "session.start", "user.prompt.submit", "tool.before.execute", "tool.after.execute",
  "step.finish", "assistant.message", "session.idle", "session.end", "subagent.start",
  "subagent.stop", "permission.denied", "compact.before", "compact.after",
  "goal.transition", "turn.failure",
];
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const DOMAIN = /^(?=.{1,253}$)(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function isExactPluginVersion(value: unknown): value is string {
  return typeof value === "string" && EXACT_VERSION.test(value);
}

export function isContributionType(value: unknown): value is PluginContributionType {
  return typeof value === "string" && PLUGIN_CONTRIBUTION_TYPES.includes(value as PluginContributionType);
}

export function parsePluginManifest(value: unknown): { manifest: PluginManifestV1 | null; error?: string } {
  if (value === undefined) return { manifest: null };
  if (!isRecord(value)) return invalid("must be an object");
  if (!hasOnly(value, ["schemaVersion", "name", "version", "apiVersion", "contributions", "requiredCapabilities", "provenance"]))
    return invalid("contains unknown fields");
  if (value.schemaVersion !== 1 || value.apiVersion !== PLUGIN_API_VERSION) return invalid("uses an unsupported schema or API version");
  if (!isBounded(value.name, 1, 200) || !PACKAGE_NAME.test(value.name)) return invalid("has an invalid name");
  if (!isExactPluginVersion(value.version)) return invalid("version must be exact semver");
  if (!isUniqueArray(value.contributions, isContributionType, PLUGIN_CONTRIBUTION_TYPES.length)) return invalid("has invalid contributions");
  if (!Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.length > 128) return invalid("has invalid requiredCapabilities");
  const capabilities: PluginCapability[] = [];
  const seen = new Set<string>();
  for (const raw of value.requiredCapabilities) {
    const parsed = parseCapability(raw);
    if (!parsed) return invalid("has an unknown or invalid capability");
    const key = JSON.stringify(parsed);
    if (seen.has(key)) return invalid("has duplicate capabilities");
    seen.add(key);
    capabilities.push(parsed);
  }
  if (!isRecord(value.provenance) || !hasOnly(value.provenance, ["source", "package"])) return invalid("has invalid provenance");
  if (value.provenance.source !== "npm" && value.provenance.source !== "local") return invalid("has invalid provenance source");
  if (value.provenance.package !== undefined && (!isBounded(value.provenance.package, 1, 200) || !PACKAGE_NAME.test(value.provenance.package)))
    return invalid("has invalid provenance package");
  return {
    manifest: deepFreeze({
      schemaVersion: 1,
      name: value.name,
      version: value.version,
      apiVersion: 1,
      contributions: [...value.contributions],
      requiredCapabilities: capabilities,
      provenance: {
        source: value.provenance.source,
        ...(value.provenance.package === undefined ? {} : { package: value.provenance.package }),
      },
    }),
  };
}

export function manifestCompatibilityError(manifest: PluginManifestV1): string | undefined {
  if (manifest.apiVersion !== PLUGIN_API_VERSION)
    return `Plugin API ${String(manifest.apiVersion)} is incompatible with host API ${PLUGIN_API_VERSION}`;
  return undefined;
}

function parseCapability(value: unknown): PluginCapability | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "tool":
      return hasOnly(value, ["type", "name"]) && safeIdentifier(value.name) ? { type: "tool", name: value.name } : null;
    case "hook":
      return hasOnly(value, ["type", "name"]) && HOOK_NAMES.includes(value.name as HookName)
        ? { type: "hook", name: value.name as HookName } : null;
    case "network-domain":
      return hasOnly(value, ["type", "domain"]) && typeof value.domain === "string" && DOMAIN.test(value.domain)
        ? { type: "network-domain", domain: value.domain.toLowerCase() } : null;
    case "filesystem-root":
      return hasOnly(value, ["type", "root", "access"]) && isSafeRoot(value.root) && (value.access === "read" || value.access === "write")
        ? { type: "filesystem-root", root: value.root, access: value.access } : null;
    case "secret-handle":
      return hasOnly(value, ["type", "handle"]) && safeIdentifier(value.handle)
        ? { type: "secret-handle", handle: value.handle } : null;
    case "provider-execution":
      return hasOnly(value, ["type", "mode"]) && value.mode === "trusted-in-process-approval-required"
        ? { type: "provider-execution", mode: value.mode } : null;
    default:
      return null;
  }
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && IDENTIFIER.test(value) && !value.split("/").includes("..");
}

function isSafeRoot(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0")
    && !value.includes("\\") && !value.split("/").includes("..") && (value === "workspace" || value.startsWith("workspace/") || value === "state" || value.startsWith("state/"));
}

function isBounded(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && !value.includes("\0");
}

function isUniqueArray<T>(value: unknown, guard: (item: unknown) => item is T, max: number): value is T[] {
  return Array.isArray(value) && value.length <= max && value.every(guard) && new Set(value).size === value.length;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function invalid(detail: string): { manifest: null; error: string } {
  return { manifest: null, error: `Invalid PluginManifestV1: ${detail}` };
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}
