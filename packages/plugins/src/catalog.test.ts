import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalCatalogBytes, verifyCatalogIndex } from "./catalog.ts";

const keys = generateKeyPairSync("ed25519");
const trusted = new Map([["release-2026", keys.publicKey]]);
const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function entry(overrides: Record<string, unknown> = {}) {
  const base = {
    kind: "plugin",
    id: "@vibe/example",
    version: "1.2.3",
    artifact: { source: "npm", locator: "@vibe/example@1.2.3", integrity },
    requiredCapabilities: [
      { type: "network-domain", domain: "api.example.com" },
      { type: "filesystem-root", root: "workspace/packages", access: "read" },
      { type: "secret-handle", handle: "example/token" },
    ],
    manifest: {
      schemaVersion: 1,
      name: "@vibe/example",
      version: "1.2.3",
      apiVersion: 1,
      contributions: ["tools"],
      requiredCapabilities: [
        { type: "network-domain", domain: "api.example.com" },
        { type: "filesystem-root", root: "workspace/packages", access: "read" },
        { type: "secret-handle", handle: "example/token" },
      ],
      provenance: { source: "npm", package: "@vibe/example" },
    },
  };
  return { ...base, ...overrides };
}

function signed(entries: unknown[] = [entry()], keyId = "release-2026") {
  const body = { schemaVersion: 1, generatedAt: "2026-07-20T12:00:00.000Z", entries };
  const signature = sign(null, canonicalCatalogBytes(body), keys.privateKey).toString("base64");
  return JSON.stringify({ ...body, signing: { algorithm: "ed25519", keyId, signature } });
}

test("verifies a signed catalog into immutable review data", () => {
  const catalog = verifyCatalogIndex(signed(), trusted);
  expect(catalog.signingKeyId).toBe("release-2026");
  expect(catalog.entries[0]?.manifest?.name).toBe("@vibe/example");
  expect(Object.isFrozen(catalog)).toBe(true);
  expect(Object.isFrozen(catalog.entries[0]?.requiredCapabilities)).toBe(true);
});

test("rejects unsigned, unknown-key, and tampered catalogs", () => {
  const valid = JSON.parse(signed()) as Record<string, any>;
  expect(() => verifyCatalogIndex(JSON.stringify({ schemaVersion: 1, generatedAt: valid.generatedAt, entries: valid.entries }), trusted)).toThrow();
  expect(() => verifyCatalogIndex(signed([entry()], "missing"), trusted)).toThrow("Unknown");
  valid.entries[0].version = "9.9.9";
  expect(() => verifyCatalogIndex(JSON.stringify(valid), trusted)).toThrow("signature");
});

test("rejects duplicate identities, version ranges, traversal, and malformed integrity", () => {
  expect(() => verifyCatalogIndex(signed([entry(), entry()]), trusted)).toThrow("Duplicate");
  expect(() => verifyCatalogIndex(signed([entry({ version: "^1.2.3" })]), trusted)).toThrow("exact version");
  expect(() => verifyCatalogIndex(signed([entry({ artifact: { source: "https", locator: "https://example.com/../plugin.tgz", integrity } })]), trusted)).toThrow("Invalid artifact");
  expect(() => verifyCatalogIndex(signed([entry({ artifact: { source: "npm", locator: "@vibe/example@1.2.3", integrity: "sha512-nope" } })]), trusted)).toThrow("Invalid artifact");
});

test("rejects manifest mismatches, unknown fields, and self-declared trust", () => {
  const mismatch = entry();
  (mismatch.manifest as Record<string, any>).version = "1.2.4";
  expect(() => verifyCatalogIndex(signed([mismatch]), trusted)).toThrow("mismatch");
  expect(() => verifyCatalogIndex(signed([{ ...entry(), bundled: true }]), trusted)).toThrow("Invalid plugin catalog entry");
  const trustedManifest = entry();
  (trustedManifest.manifest as Record<string, any>).trustedInProcess = true;
  expect(() => verifyCatalogIndex(signed([trustedManifest]), trusted)).toThrow("unknown fields");
});

test("catalog capabilities and plugin manifest capabilities must match exactly", () => {
  const different = entry({ requiredCapabilities: [{ type: "tool", name: "repo.search" }] });
  expect(() => verifyCatalogIndex(signed([different]), trusted)).toThrow("capability mismatch");
});
