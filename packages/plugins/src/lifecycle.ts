import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { deepFreeze } from "./manifest.ts";
import type { CatalogEntryV1 } from "./catalog.ts";

export interface InstalledExtensionVersionV1 {
  version: string;
  integrity: string;
  artifactPath: string;
  installedAt: string;
}

export interface InstalledExtensionV1 {
  kind: CatalogEntryV1["kind"];
  id: string;
  activeVersion: string;
  enabled: boolean;
  previousVersions: string[];
  versions: InstalledExtensionVersionV1[];
}

interface ExtensionLockV1 {
  schemaVersion: 1;
  entries: InstalledExtensionV1[];
}

/** Durable, network-free lifecycle for curated extension artifacts. Catalog
 * verification happens before this boundary; this store re-verifies the full
 * staged artifact before atomically changing the active lock. */
export class ExtensionLifecycleStore {
  readonly root: string;
  #chain = Promise.resolve();

  constructor(root: string) {
    this.root = root;
  }

  list(): Promise<readonly InstalledExtensionV1[]> {
    return this.#serialized(async () => deepFreeze(cloneEntries((await this.#readLock()).entries)));
  }

  install(entry: CatalogEntryV1, stagedArtifactPath: string): Promise<InstalledExtensionV1> {
    return this.#serialized(async () => {
      const lock = await this.#readLock();
      const key = extensionKey(entry.kind, entry.id);
      const existing = lock.entries.find((item) => extensionKey(item.kind, item.id) === key);
      const installed = existing?.versions.find((item) => item.version === entry.version);
      if (installed && installed.integrity !== entry.artifact.integrity)
        throw new Error(`Locked integrity conflict for ${entry.id}@${entry.version}`);

      const artifactDir = join(this.root, "artifacts", safeSegment(key), entry.version);
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      const artifactPath = join(artifactDir, `${safeSegment(entry.artifact.integrity)}.artifact`);
      // Verify the full staged bytes on every call, including idempotent
      // reinstalls. A lock record never turns a later filename into evidence.
      await copyVerified(stagedArtifactPath, artifactPath, entry.artifact.integrity);

      const now = new Date().toISOString();
      const versionRecord = installed ?? {
        version: entry.version,
        integrity: entry.artifact.integrity,
        artifactPath,
        installedAt: now,
      };
      let next: InstalledExtensionV1;
      if (existing) {
        const previousVersions = existing.activeVersion === entry.version
          ? existing.previousVersions
          : [existing.activeVersion, ...existing.previousVersions.filter((version) => version !== existing.activeVersion && version !== entry.version)].slice(0, 20);
        next = {
          ...existing,
          activeVersion: entry.version,
          enabled: true,
          previousVersions,
          versions: installed ? existing.versions : [...existing.versions, versionRecord],
        };
        lock.entries = lock.entries.map((item) => extensionKey(item.kind, item.id) === key ? next : item);
      } else {
        next = { kind: entry.kind, id: entry.id, activeVersion: entry.version, enabled: true, previousVersions: [], versions: [versionRecord] };
        lock.entries.push(next);
      }
      await this.#writeLock(lock);
      return deepFreeze(cloneEntry(next));
    });
  }

  setEnabled(kind: CatalogEntryV1["kind"], id: string, enabled: boolean): Promise<InstalledExtensionV1> {
    return this.#serialized(async () => {
      const lock = await this.#readLock();
      const current = lock.entries.find((entry) => entry.kind === kind && entry.id === id);
      if (!current) throw new Error(`Extension is not installed: ${kind}:${id}`);
      if (enabled) {
        const active = current.versions.find((version) => version.version === current.activeVersion)!;
        await verifyFileIntegrity(active.artifactPath, active.integrity);
      }
      const next = { ...current, enabled };
      lock.entries = lock.entries.map((entry) => entry === current ? next : entry);
      await this.#writeLock(lock);
      return deepFreeze(cloneEntry(next));
    });
  }

  rollback(kind: CatalogEntryV1["kind"], id: string): Promise<InstalledExtensionV1> {
    return this.#serialized(async () => {
      const lock = await this.#readLock();
      const current = lock.entries.find((entry) => entry.kind === kind && entry.id === id);
      if (!current) throw new Error(`Extension is not installed: ${kind}:${id}`);
      const target = current.previousVersions.find((version) => current.versions.some((item) => item.version === version));
      if (!target) throw new Error(`No rollback version is available for ${kind}:${id}`);
      const targetRecord = current.versions.find((version) => version.version === target)!;
      await verifyFileIntegrity(targetRecord.artifactPath, targetRecord.integrity);
      const next = {
        ...current,
        activeVersion: target,
        enabled: true,
        previousVersions: [current.activeVersion, ...current.previousVersions.filter((version) => version !== target && version !== current.activeVersion)].slice(0, 20),
      };
      lock.entries = lock.entries.map((entry) => entry === current ? next : entry);
      await this.#writeLock(lock);
      return deepFreeze(cloneEntry(next));
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation, operation);
    this.#chain = result.then(() => undefined, () => undefined);
    return result;
  }

  async #readLock(): Promise<ExtensionLockV1> {
    try {
      const parsed = JSON.parse(await readFile(join(this.root, "extensions.lock.json"), "utf8")) as unknown;
      if (!validLock(parsed)) throw new Error("Extension lock is invalid");
      const prefix = `${resolve(this.root)}${sep}`;
      for (const entry of parsed.entries) {
        for (const version of entry.versions) {
          if (!resolve(version.artifactPath).startsWith(prefix)) throw new Error("Extension lock contains an unsafe artifact path");
        }
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, entries: [] };
      throw error;
    }
  }

  async #writeLock(lock: ExtensionLockV1): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
    const path = join(this.root, "extensions.lock.json");
    const temp = join(this.root, `.extensions.lock.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
    await chmod(path, 0o600);
  }
}

async function copyVerified(source: string, destination: string, expectedSri: string): Promise<void> {
  const expected = expectedSri.slice("sha512-".length);
  const temp = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  const hash = createHash("sha512");
  const meter = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  try {
    await stat(source);
    await pipeline(createReadStream(source), meter, createWriteStream(temp, { flags: "wx", mode: 0o600 }));
    const actual = hash.digest("base64");
    if (actual !== expected) throw new Error("Staged extension artifact does not match catalog integrity");
    await rename(temp, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function verifyFileIntegrity(path: string, expectedSri: string): Promise<void> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("base64") !== expectedSri.slice("sha512-".length))
    throw new Error("Stored extension artifact does not match locked integrity");
}

function extensionKey(kind: string, id: string): string { return `${kind}:${id}`; }
function safeSegment(value: string): string { return createHash("sha256").update(value).digest("base64url"); }

function cloneEntry(entry: InstalledExtensionV1): InstalledExtensionV1 {
  return { ...entry, previousVersions: [...entry.previousVersions], versions: entry.versions.map((version) => ({ ...version })) };
}
function cloneEntries(entries: InstalledExtensionV1[]): InstalledExtensionV1[] { return entries.map(cloneEntry); }

function validLock(value: unknown): value is ExtensionLockV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lock = value as Record<string, unknown>;
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.entries) || Object.keys(lock).some((key) => !["schemaVersion", "entries"].includes(key))) return false;
  const keys = new Set<string>();
  for (const raw of lock.entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const entryKeys = Object.keys(raw);
    if (entryKeys.some((key) => !["kind", "id", "activeVersion", "enabled", "previousVersions", "versions"].includes(key))) return false;
    const entry = raw as InstalledExtensionV1;
    if (!["plugin", "skill", "mcp"].includes(entry.kind) || typeof entry.id !== "string" || typeof entry.activeVersion !== "string"
      || typeof entry.enabled !== "boolean" || !Array.isArray(entry.previousVersions) || !entry.previousVersions.every((item) => typeof item === "string")
      || !Array.isArray(entry.versions) || !entry.versions.some((item) => item.version === entry.activeVersion)
      || entry.versions.some((item) => !item || Object.keys(item).some((key) => !["version", "integrity", "artifactPath", "installedAt"].includes(key))
        || typeof item.version !== "string" || !validSri(item.integrity) || typeof item.artifactPath !== "string" || typeof item.installedAt !== "string")) return false;
    const key = extensionKey(entry.kind, entry.id);
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function validSri(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("sha512-")) return false;
  const encoded = value.slice("sha512-".length);
  const decoded = Buffer.from(encoded, "base64");
  return decoded.byteLength === 64 && decoded.toString("base64") === encoded;
}
