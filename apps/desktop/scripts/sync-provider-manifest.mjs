#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = resolve(process.env.VIBE_CODR_ROOT || [
  resolve(root, "..", ".."),
  join(root, "..", "cli"),
  join(root, "..", "vibe-codr"),
  join(homedir(), "Code", "vibe-codr"),
  join(homedir(), "code", "vibe-codr"),
].find((candidate) => existsSync(join(candidate, "package.json"))) || join(root, "..", "vibe-codr"));
const source = process.argv[2] ?? "https://models.dev/api.json";

const raw = source.startsWith("http://") || source.startsWith("https://")
  ? await fetch(source, { signal: AbortSignal.timeout(20_000) }).then((response) => {
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
      return response.json();
    })
  : JSON.parse(await readFile(resolve(source), "utf8"));

if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
  throw new Error("models.dev payload is not a provider object");
}

const credentialEnv = (env) => {
  const values = Array.isArray(env) ? env.filter((value) => typeof value === "string") : [];
  const credentials = values.filter((value) =>
    /(?:API_KEY|TOKEN|PAT|SECRET|ACCESS_KEY_ID|BEARER)/.test(value),
  );
  return credentials.length > 0 ? credentials : values;
};

const entries = Object.values(raw)
  .filter((provider) => provider && typeof provider.id === "string")
  .map((provider) => {
    const models = Object.values(provider.models ?? {})
      .filter((model) => model && typeof model.id === "string" && model.status !== "deprecated")
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      id: provider.id,
      name: typeof provider.name === "string" ? provider.name : provider.id,
      env: credentialEnv(provider.env),
      baseURL: typeof provider.api === "string" ? provider.api : "",
      npm: typeof provider.npm === "string" ? provider.npm : "@ai-sdk/openai-compatible",
      defaultModel: models[0]?.id ?? "",
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

if (entries.length < 75) {
  throw new Error(`refusing to write an incomplete provider manifest (${entries.length} entries)`);
}

const body = `/**
 * Generated from models.dev/api.json by scripts/sync-provider-manifest.mjs.
 * Do not hand-edit. Curated labels/defaults and native auth overrides live in
 * providers-catalog.ts and the engine provider registry respectively.
 */
export interface ProviderManifestEntry {
  id: string;
  name: string;
  env: readonly string[];
  baseURL: string;
  npm: string;
  defaultModel: string;
}

export const PROVIDER_MANIFEST: readonly ProviderManifestEntry[] = ${JSON.stringify(entries, null, 2).replaceAll("${", "\\u0024{")} as const;
`;

const outputs = [
  join(root, "src/shared/provider-manifest.ts"),
  join(engineRoot, "packages/providers/src/provider-manifest.ts"),
];
for (const output of outputs) await writeFile(output, body);

console.log(`Synced ${entries.length} models.dev providers to ${outputs.length} manifests.`);
