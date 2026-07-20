import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalCatalogBytes } from "@vibe/plugins";
import { runExtensionsCommand } from "./extensions-command.ts";

test("signed extension CLI requires capability review and controls the atomic lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-ext-cli-"));
  const artifact = join(root, "plugin.js");
  await writeFile(artifact, "export default 1\n");
  const integrity = `sha512-${createHash("sha512").update(Buffer.from(await Bun.file(artifact).arrayBuffer())).digest("base64")}`;
  const entry = { kind: "skill", id: "safe-skill", version: "1.0.0", artifact: { source: "npm", locator: "safe-skill@1.0.0", integrity }, requiredCapabilities: [{ type: "network-domain", domain: "api.example.com" }] };
  const payload = { schemaVersion: 1, generatedAt: "2026-07-20T00:00:00.000Z", entries: [entry] };
  const keys = generateKeyPairSync("ed25519");
  const catalog = join(root, "catalog.json");
  const key = join(root, "public.pem");
  await writeFile(key, keys.publicKey.export({ type: "spki", format: "pem" }));
  await writeFile(catalog, JSON.stringify({ ...payload, signing: { algorithm: "ed25519", keyId: "curated", signature: sign(null, canonicalCatalogBytes(payload), keys.privateKey).toString("base64") } }));
  const common = { args: ["install", catalog], root: join(root, "state"), catalogKey: key, keyId: "curated", entry: "skill:safe-skill@1.0.0", artifact };
  expect((await runExtensionsCommand(common)).stderr).toContain("Review capabilities");
  expect((await runExtensionsCommand({ ...common, confirmCapabilities: true })).exitCode).toBe(0);
  expect((await runExtensionsCommand({ args: ["disable", "skill:safe-skill"], root: common.root })).stdout).toContain('"enabled": false');
});
