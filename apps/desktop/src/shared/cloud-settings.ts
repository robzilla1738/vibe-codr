import type { CloudSettingsPublic } from "./cloud";

export type CloudSettingsPatch = Partial<Pick<CloudSettingsPublic,
  | "experimentalEnabled"
  | "transferModelCredentials"
  | "lastProvider"
  | "autoPauseMinutes"
  | "deleteOnReturn"
  | "allowedDomains"
  | "additionalExclusions"
>>;

const PATCH_KEYS = new Set<keyof CloudSettingsPatch>([
  "experimentalEnabled",
  "transferModelCredentials",
  "lastProvider",
  "autoPauseMinutes",
  "deleteOnReturn",
  "allowedDomains",
  "additionalExclusions",
]);

/** Validate the renderer/mobile boundary before a partial settings object is
 * merged into the durable Cloud settings file. */
export function parseCloudSettingsPatch(value: unknown): CloudSettingsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Cloud settings update");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !PATCH_KEYS.has(key as keyof CloudSettingsPatch))) {
    throw new Error("Cloud settings update contains an unsupported field");
  }
  const patch: CloudSettingsPatch = {};
  for (const key of ["experimentalEnabled", "transferModelCredentials", "deleteOnReturn"] as const) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== "boolean") throw new Error(`${key} must be true or false`);
    patch[key] = field;
  }
  if (input.lastProvider !== undefined) {
    if (input.lastProvider !== "e2b" && input.lastProvider !== "vercel") {
      throw new Error("lastProvider must be e2b or vercel");
    }
    patch.lastProvider = input.lastProvider;
  }
  if (input.autoPauseMinutes !== undefined) {
    if (!Number.isSafeInteger(input.autoPauseMinutes)
      || (input.autoPauseMinutes as number) < 1
      || (input.autoPauseMinutes as number) > 120) {
      throw new Error("autoPauseMinutes must be a whole number from 1 to 120");
    }
    patch.autoPauseMinutes = input.autoPauseMinutes as number;
  }
  if (input.allowedDomains !== undefined) {
    patch.allowedDomains = normalizedList(input.allowedDomains, 64, (entry) => {
      if (entry.length > 253 || entry.includes(":") || entry.includes("/") || entry.includes("@")
        || entry.startsWith(".") || entry.endsWith(".")
        || !entry.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
        throw new Error(`Invalid Cloud network hostname: ${entry}`);
      }
      return entry.toLowerCase();
    });
  }
  if (input.additionalExclusions !== undefined) {
    patch.additionalExclusions = normalizedList(input.additionalExclusions, 128, (entry) => {
      const normalized = entry.replace(/^\.\//, "");
      if (normalized.length > 1_024 || normalized.startsWith("/") || normalized === ".."
        || normalized.startsWith("../") || normalized.includes("/../")
        || normalized.includes("\\") || normalized.includes("\0")) {
        throw new Error(`Invalid Cloud workspace exclusion: ${entry}`);
      }
      return normalized;
    });
  }
  return patch;
}

function normalizedList(
  value: unknown,
  maxItems: number,
  normalize: (entry: string) => string,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error("Invalid Cloud settings list");
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) throw new Error("Cloud settings lists require non-empty strings");
    result.push(normalize(item.trim()));
  }
  return [...new Set(result)];
}
