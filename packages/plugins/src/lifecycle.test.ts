import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogEntryV1 } from "./catalog.ts";
import { ExtensionLifecycleStore } from "./lifecycle.ts";

function fixture(version: string, contents: string): { entry: CatalogEntryV1; contents: string } {
  const integrity = `sha512-${createHash("sha512").update(contents).digest("base64")}`;
  return {
    contents,
    entry: {
      kind: "plugin",
      id: "@vibe/example",
      version,
      artifact: { source: "npm", locator: `@vibe/example@${version}`, integrity },
      requiredCapabilities: [],
      manifest: {
        schemaVersion: 1, name: "@vibe/example", version, apiVersion: 1,
        contributions: ["tools"], requiredCapabilities: [],
        provenance: { source: "npm", package: "@vibe/example" },
      },
    },
  };
}

async function stage(root: string, name: string, contents: string): Promise<string> {
  const path = join(root, name);
  await Bun.write(path, contents);
  return path;
}

test("installs a fully verified artifact into an exact immutable lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-extension-lock-"));
  const store = new ExtensionLifecycleStore(join(root, "store"));
  const item = fixture("1.0.0", "complete package bytes");
  const installed = await store.install(item.entry, await stage(root, "package.tgz", item.contents));
  expect(installed.activeVersion).toBe("1.0.0");
  expect(await readFile(installed.versions[0]!.artifactPath, "utf8")).toBe(item.contents);
  expect((await stat(join(root, "store", "extensions.lock.json"))).mode & 0o777).toBe(0o600);
  const listed = await store.list();
  expect(listed).toHaveLength(1);
  expect(Object.isFrozen(listed[0]?.versions)).toBe(true);
});

test("mismatched package bytes never activate or change the lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-extension-mismatch-"));
  const store = new ExtensionLifecycleStore(join(root, "store"));
  const item = fixture("1.0.0", "expected bytes");
  await expect(store.install(item.entry, await stage(root, "package.tgz", "tampered bytes"))).rejects.toThrow("integrity");
  expect(await store.list()).toEqual([]);
});

test("updates, disables, rolls back, and treats repeat installs idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-extension-update-"));
  const store = new ExtensionLifecycleStore(join(root, "store"));
  const one = fixture("1.0.0", "v1");
  const two = fixture("2.0.0", "v2");
  await store.install(one.entry, await stage(root, "v1.tgz", one.contents));
  await store.install(two.entry, await stage(root, "v2.tgz", two.contents));
  await store.install(two.entry, await stage(root, "v2-again.tgz", two.contents));
  expect((await store.list())[0]?.versions).toHaveLength(2);
  expect((await store.setEnabled("plugin", "@vibe/example", false)).enabled).toBe(false);
  const rolledBack = await store.rollback("plugin", "@vibe/example");
  expect(rolledBack.activeVersion).toBe("1.0.0");
  expect(rolledBack.enabled).toBe(true);
  expect(rolledBack.previousVersions[0]).toBe("2.0.0");
});

test("refuses to activate a stored rollback artifact whose bytes changed", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-extension-rollback-integrity-"));
  const store = new ExtensionLifecycleStore(join(root, "store"));
  const one = fixture("1.0.0", "v1");
  const two = fixture("2.0.0", "v2");
  const installedOne = await store.install(one.entry, await stage(root, "v1.tgz", one.contents));
  await store.install(two.entry, await stage(root, "v2.tgz", two.contents));
  await Bun.write(installedOne.versions[0]!.artifactPath, "tampered");
  await expect(store.rollback("plugin", "@vibe/example")).rejects.toThrow("locked integrity");
  expect((await store.list())[0]?.activeVersion).toBe("2.0.0");
});
